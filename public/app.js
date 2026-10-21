'use strict';

const $ = id => document.getElementById(id);
const MAX_BYTES = 500 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const blooms = ['Remember','Understand','Apply','Analyze','Evaluate','Create'];

let books = [];
let questions = [];
let questionBank = [];
let exams = [];
let currentExamId = null;
let currentExamBlueprint = null;
let currentExamBlueprintKey = '';
let lastBlueprintValidation = null;

function uid(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}
function esc(v){
  return String(v ?? '').replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}
function adminPassword(){
  let p = sessionStorage.getItem('ghdd_admin_password') || '';
  if(!p){
    p = prompt('Geli furaha maamulka ee Railway ADMIN_PASSWORD:') || '';
    if(p) sessionStorage.setItem('ghdd_admin_password',p);
  }
  return p;
}
function headers(json=true){
  const h={'x-admin-password':adminPassword()};
  if(json) h['Content-Type']='application/json';
  return h;
}
async function api(url,options={}){
  const response=await fetch(url,{
    ...options,
    headers:{...headers(),...(options.headers||{})}
  });
  let data={};
  try{data=await response.json()}catch(_){}
  if(!response.ok) throw new Error(data.error||`Server error ${response.status}`);
  return data;
}
function showTab(id){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.id===id));
  document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('active',x.dataset.tab===id));
  try{
    if(id==='books') loadBooks();
    if(id==='lessonplan') loadLessonBookOptions();
    if(id==='bank') renderBank();
    if(id==='dashboard') loadDashboard();
  }catch(err){console.error('Tab loader failed:',err);}
  window.scrollTo({top:0,behavior:'smooth'});
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>showTab(b.dataset.go));
window.__ghddTabs=true;

async function checkHealth(){
  try{
    const r=await fetch('/api/health');
    const d=await r.json();
    $('healthStatus').textContent=d.ok
      ? 'Server-ka iyo PostgreSQL way shaqaynayaan.'
      : 'Database-ka lama xaqiijin: '+(d.error||'');
  }catch(e){
    $('healthStatus').textContent='Server-ka lama xiriirin: '+e.message;
  }
}
$('checkHealth').onclick=checkHealth;
checkHealth();

$('bookFile').addEventListener('change',()=>{
  const file=$('bookFile').files[0];
  if(!file){$('fileInfo').textContent='Weli PDF lama dooran.';return;}
  $('fileInfo').textContent=`${file.name} · ${(file.size/1024/1024).toFixed(2)} MB`;
});

function progress(percent,message){
  $('progressBox').classList.remove('hidden');
  $('progressBar').style.width=Math.min(100,Math.max(0,percent))+'%';
  $('uploadStatus').textContent=message;
  const activeUpload=document.activeElement && document.activeElement.id==='lpUploadTextbook'?'lpTextbookUploadStatus':
    (document.activeElement && document.activeElement.id==='lpUploadScheme'?'lpSchemeUploadStatus':null);
  for(const id of ['lpSchemeUploadStatus','lpTextbookUploadStatus']){
    const el=$(id);
    if(el && el.dataset.uploading==='yes') el.textContent=`${percent}% — ${message}`;
  }
}
function readSlice(file,start,end){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(new Error('PDF-ga qaybtiisa lama akhrin karin.'));
    reader.readAsArrayBuffer(file.slice(start,end));
  });
}
function blobBase64(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>{
      const value=String(reader.result);
      resolve(value.slice(value.indexOf(',')+1));
    };
    reader.onerror=()=>reject(new Error('Qaybta PDF-ga lama beddeli karin.'));
    reader.readAsDataURL(blob);
  });
}

$('uploadBook').onclick=async()=>{
  const file=$('bookFile').files[0];
  const title=$('bookTitle').value.trim();
  const subject=$('bookSubject').value.trim();
  const btn=$('uploadBook');
  if(!file) return alert('Dooro PDF marka hore.');
  if(file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf'))
    return alert('Fadlan dooro fayl PDF ah.');
  if(file.size>MAX_BYTES)
    return alert('PDF-gu wuxuu ka weyn yahay xadka 500 MB.');
  if(!title) return alert('Geli magaca buugga.');
  if(!window.pdfjsLib) return alert('PDF.js lama helin. Hubi internetka.');

  btn.disabled=true;
  let bookId=null;

  try{
    pdfjsLib.GlobalWorkerOptions.workerSrc=
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    // PDF.js wuxuu u baahan yahay inuu akhriyo PDF-ga si loo ogaado
    // bogagga iyo qoraalka. Fayl aad u weyn wuxuu u baahan karaa RAM badan.
    progress(1,'PDF-ga ayaa la furayaa...');
    const pdfData=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:pdfData}).promise;

    if(pdf.numPages>3000) throw new Error('Buuggu wuxuu ka badan yahay xadka 3000 bog.');

    progress(3,`PDF-ga wuxuu leeyahay ${pdf.numPages} bog. OCR ayaa bilaabanaya...`);

    // Fast, quality-preserving page pipeline:
    // - Extract embedded text first on every page; OCR only when needed.
    // - Process two pages concurrently, each with its own Tesseract worker.
    // - Keep the same 1.6 render scale and confidence checks to protect quality.
    const pagesByNumber=new Array(pdf.numPages);
    let ocrCount=0;
    let embeddedCount=0;
    let lowQualityCount=0;
    let processedCount=0;
    let nextPage=1;
    const ocrLang=$('ocrLanguage')?.value || 'eng';
    const OCR_CONCURRENCY=2;
    const ocrWorkers=[null,null];

    const processPage=async(n,slot)=>{
      const page=await pdf.getPage(n);
      try{
        const content=await page.getTextContent({disableCombineTextItems:false});
        let text='';
        let method='embedded';
        let confidence=100;
        try {
          const lines=[];
          let line='';
          for(const item of (content.items||[])){
            const str=String(item.str||'');
            if(str) line += (line && item.hasEOL!==true ? ' ' : '') + str;
            if(item.hasEOL){ if(line.trim()) lines.push(line.trim()); line=''; }
          }
          if(line.trim()) lines.push(line.trim());
          text=lines.join('\n').trim();
        } catch(_) {
          text=(content.items||[]).map(x=>x.str||'').join(' ').trim();
        }

        const usefulChars=(text.match(/[A-Za-z0-9\u0600-\u06FF\u0750-\u077F]/g)||[]).length;
        const usefulRatio=text.length ? usefulChars/text.length : 0;
        const needsOcr=text.length<35 || usefulRatio<0.42;

        if(needsOcr){
          if(!window.Tesseract) throw new Error('OCR lama soo dejin. Hubi internetka.');
          if(!ocrWorkers[slot]){
            progress(3+Math.round((processedCount/pdf.numPages)*32),`Diyaarinaya OCR (${ocrLang}) — worker ${slot+1}/${OCR_CONCURRENCY}...`);
            ocrWorkers[slot]=await Tesseract.createWorker(ocrLang,1,{
              logger:m=>{
                if(m.status==='recognizing text' && Number.isFinite(m.progress)){
                  progress(3+Math.round((processedCount/pdf.numPages)*32),`OCR: bogga ${n}/${pdf.numPages} (${Math.round(m.progress*100)}%) · shaqaale ${slot+1}/${OCR_CONCURRENCY}`);
                }
              }
            });
            try { await ocrWorkers[slot].setParameters({preserve_interword_spaces:'1'}); } catch(_) {}
          }
          const viewport=page.getViewport({scale:1.6});
          const canvas=document.createElement('canvas');
          canvas.width=Math.ceil(viewport.width);
          canvas.height=Math.ceil(viewport.height);
          const ctx=canvas.getContext('2d',{willReadFrequently:false});
          await page.render({canvasContext:ctx,viewport}).promise;
          const result=await ocrWorkers[slot].recognize(canvas);
          const ocrText=String(result.data?.text||'').trim();
          const rawConfidence=Number(result.data?.confidence);
          const ocrConfidence=Number.isFinite(rawConfidence)?rawConfidence:null;
          const ocrUseful=(ocrText.match(/[A-Za-z0-9\u0600-\u06FF\u0750-\u077F]/g)||[]).length;
          const ocrRatio=ocrText.length ? ocrUseful/ocrText.length : 0;
          if(ocrText && (text.length<35 || ocrText.length>=text.length || ocrRatio>usefulRatio+0.12)){
            text=ocrText;
            method='ocr';
            confidence=ocrConfidence;
          }
          canvas.width=1; canvas.height=1;
          ocrCount++;
          if((ocrConfidence!==null&&ocrConfidence<45)||text.length<35) lowQualityCount++;
        }else{
          embeddedCount++;
        }
        pagesByNumber[n-1]={page:n,text,method,confidence};
      }finally{
        page.cleanup?.();
      }
    };

    const pageWorker=async(slot)=>{
      while(true){
        const n=nextPage++;
        if(n>pdf.numPages) return;
        await processPage(n,slot);
        processedCount++;
        const pct=3+Math.round((processedCount/pdf.numPages)*32);
        progress(pct,`Akhrinta ${processedCount}/${pdf.numPages} bog · OCR: ${ocrCount} · qoraal PDF toos ah: ${embeddedCount} · dib-u-eegis: ${lowQualityCount}`);
      }
    };

    try{
      await Promise.all(Array.from({length:Math.min(OCR_CONCURRENCY,pdf.numPages)},(_,slot)=>pageWorker(slot)));
    }finally{
      await Promise.all(ocrWorkers.filter(Boolean).map(w=>w.terminate().catch(()=>{})));
      ocrWorkers.fill(null);
    }
    const pages=pagesByNumber;

    // Bilow kaydinta buugga server-ka.
    const start=await api('/api/books/upload/start',{
      method:'POST',
      body:JSON.stringify({
        title,subject,filename:file.name,
        size:file.size,pageCount:pdf.numPages
      })
    });
    bookId=start.id;

    // PDF-ga si qaybo 4 MB ah u dir; Base64 laguma beddelayo
    // faylka oo dhan hal mar.
    const totalChunks=Math.ceil(file.size/CHUNK_BYTES);

    let uploadedChunks=0;
    let nextChunk=0;
    const uploadChunkWorker=async()=>{
      while(true){
        const i=nextChunk++;
        if(i>=totalChunks) return;
        const from=i*CHUNK_BYTES;
        const to=Math.min(file.size,from+CHUNK_BYTES);
        const encoded=await blobBase64(file.slice(from,to));
        await api(`/api/books/${encodeURIComponent(bookId)}/chunks/${i}`,{
          method:'POST', body:JSON.stringify({chunkBase64:encoded})
        });
        uploadedChunks++;
        const pct=35+Math.round((uploadedChunks/totalChunks)*55);
        progress(pct,`Kaydinta PDF: qaybta ${uploadedChunks}/${totalChunks}.`);
      }
    };
    await Promise.all(Array.from({length:Math.min(2,totalChunks)},()=>uploadChunkWorker()));

    progress(93,'PDF-ga waa la kaydiyey. Qoraalka OCR ayaa la dhammeystirayaa...');

    const saved=await api(`/api/books/${encodeURIComponent(bookId)}/upload/finish`,{
      method:'POST',
      body:JSON.stringify({pages})
    });

    progress(100,`Guul! ${title}: ${pdf.numPages} bog; qoraal PDF toos ah ${embeddedCount}; OCR ${ocrCount}; bogag tayadoodu u baahan karto dib-u-eegis ${Math.max(lowQualityCount,Number(saved.lowConfidencePages)||0)}.`);
    if(lowQualityCount>0 || Number(saved.lowConfidencePages)>0){
      console.warn('OCR quality review recommended', {lowQualityCount, saved});
    }
    $('bookFile').value='';
    $('fileInfo').textContent='Weli PDF lama dooran.';
    await loadBooks();

  }catch(e){
    console.error(e);
    progress(0,'Khalad: '+e.message);
    alert('PDF/OCR: '+e.message+
      (bookId?'\nBuugga upload-kiisu wuu bilaabmay. Hubi liiska buugaagta ka hor intaadan mar kale soo gelin.':''));
  }finally{
    btn.disabled=false;
  }
};

async function loadBooks(){
  const box=$('booksList');
  box.innerHTML='<div class="item">Buugaagta waa la soo rarayaa...</div>';
  try{
    const d=await api('/api/books',{method:'GET'});
    books=d.books||[];
    $('sourceBook').innerHTML='<option value="">Dooro buug...</option>'+
      books.map(b=>`<option value="${esc(b.id)}">${esc(b.title)} (${b.page_count||'?'} bog)</option>`).join('');

    if(!books.length){
      box.innerHTML='<div class="item muted">Weli buug lama kaydin.</div>';
      return;
    }

    box.innerHTML=books.map(b=>`
      <div class="item">
        <b>${esc(b.title)}</b>
        <p class="muted">${esc(b.subject||'Maaddo lama cayimin')} · ${b.page_count||'?'} bog · ${Number(b.text_chars||0).toLocaleString()} xaraf</p>
        <a href="/api/books/${encodeURIComponent(b.id)}/pdf" target="_blank" rel="noopener">
          <button type="button" class="secondary">Fur / Soo dejiso PDF</button>
        </a>
        <button class="danger" data-del-book="${esc(b.id)}">Tirtir</button>
      </div>`).join('');

    box.querySelectorAll('[data-del-book]').forEach(btn=>{
      btn.onclick=async()=>{
        if(!confirm('Ma hubtaa inaad buuggan tirtirayso?'))return;
        try{
          await api('/api/books/'+encodeURIComponent(btn.dataset.delBook),{method:'DELETE'});
          await loadBooks();
        }catch(e){alert(e.message);}
      };
    });
  }catch(e){
    box.innerHTML=`<div class="item">Khalad: ${esc(e.message)}</div>`;
  }
}
$('refreshBooks').onclick=loadBooks;
['sourceBook','startPage','endPage','genTotalMarks','genCount','genFormat','diagramCount','examLanguage','genLevels'].forEach(id=>{const el=$(id);if(el)el.addEventListener('change',()=>{currentExamBlueprint=null;currentExamBlueprintKey='';});});


function detectExamLanguage(source){
  const text=String(source||'');
  if(/[\u0600-\u06FF]/.test(text))return 'ar';
  const words=(text.toLowerCase().match(/[a-z]+/g)||[]);
  const somaliWords=new Set(['waa','iyo','jirka','qaybta','qaybaha','su’aal','su aal','jawaab','jawaabta','xubinta','dhig','dhiigga','qorraxda','dusha','xisaabi','sharax','sheeg','qeex','maxay','sidee','meesha','waxaa','ahaan','lagu','sida','marka','dhammaan','heerka','bogga','erayga','macnaha','tusaale','dhex','habka','waxaa','ardayga','dugsiga','cufka','xawaaraha','tamarta','dareere','koronto','xoogga']);
  let score=0;
  for(const w of words)if(somaliWords.has(w))score++;
  return score>=3?'so':'en';
}
function examText(lang,key){
  const labels={
    en:{mcq:'PART I — MULTIPLE CHOICE QUESTIONS',fill:'PART II — FILL IN THE BLANKS',matching:'PART III — MATCHING',structured:'PART IV — DIRECT / STRUCTURED QUESTIONS',name:'Name',date:'Date',class:'Class',total:'Total Marks',instructions:'Instructions',answer:'ANSWER KEY AND MARKING GUIDE',studentAnswer:'Answer',question:'Question',answerChoices:'Answer choices',matchPrompt:'Match each item in Column A with the correct option in Column B. Write only the option letter.',number:'Number',columnA:'Column A: Items',answerLetter:'Answer letter',columnB:'Column B: Options / descriptions',markingGuide:'Answer / Marking guide',notProvided:'Not provided',allQuestions:'Answer all questions. Read each question carefully.',marks:'marks',matchingKey:'Answer key',blueprint:'AI Exam Blueprint / Table of Specifications',subjectLabel:'Subject',languageLabel:'Language',unitLabel:'Unit / Chapter',topicLabel:'Topic',outcomesLabel:'Learning outcomes',bloomLabel:'Bloom distribution',questionsLabel:'Questions',marksLabel:'Marks',pagesLabel:'Pages',source:'Source',objectiveLabel:'Learning objective',questionsDefault:'Questions',passageLabel:'Reading Passage',passageInstruction:'Read the passage carefully, then answer the questions that follow.',passageSection:'Part One: Reading Comprehension',mcqPassageNote:'answer from the passage above',tos:'Table of Specifications (TOS)',itemsLabel:'Items',weightLabel:'Weight %',qNumbers:'Question numbers',sectionsLabel:'Exam structure',typeLabel:'Question type',otherLabel:'Other (not linked to a topic)',tosPlanned:'Planned from the blueprint. Question numbers appear after the exam is generated.',tosActual:'Based on the generated exam (question numbers are shown in brackets).',passagePart1:'First: Comprehension — Read the passage above carefully, then circle the letter before the correct answer, using the passage.',passagePart2:'Second: Grammar and Style — Circle the letter before the correct answer (the examples are taken from the passage).',passagePart3:'Third: Vocabulary and Expressions — Circle the letter before the correct answer.'},
    so:{mcq:'QAYBTA I — SU’AALAHA DOORASHADA',fill:'QAYBTA II — MEELAHA BANNAAN',matching:'QAYBTA III — ISKU-AADINTA',structured:'QAYBTA IV — SU’AALAHA TOOSKA AH / QAABAYSAN',name:'Magaca',date:'Taariikhda',class:'Fasalka',total:'Wadarta dhibcaha',instructions:'Tilmaamaha',answer:'JAWAABAHA SAXDA AH IYO HABKA SAXIDDA',studentAnswer:'Jawaabta',question:'Su’aasha',answerChoices:'Doorashooyinka jawaabaha',matchPrompt:'Qaybta A iyo Qaybta B isku-aadi. Ku qor xarafka doorashada saxda ah oo keliya.',number:'Lambarka',columnA:'Qaybta A: Erayga / Su’aasha',answerLetter:'Xarafka jawaabta',columnB:'Qaybta B: Jawaabaha / Sharaxaadda',markingGuide:'Jawaabta saxda ah / Habka sixidda',notProvided:'Jawaab lama bixin',allQuestions:'Ka jawaab dhammaan su’aalaha. Su’aal kasta si taxaddar leh u akhri.',marks:'dhibcood',matchingKey:'Jawaabaha saxda ah',blueprint:'Qorshaha Imtixaanka (Blueprint)',subjectLabel:'Maaddada',languageLabel:'Luqadda',unitLabel:'Cutubka',topicLabel:'Mawduuca',outcomesLabel:'Ujeeddooyinka waxbarasho',bloomLabel:'Qaybinta Bloom',questionsLabel:'Su’aalaha',marksLabel:'Dhibcaha',pagesLabel:'Bogagga',source:'Isha',objectiveLabel:'Ujeeddada waxbarasho',questionsDefault:'Su’aalaha',passageLabel:'Sheeko / Qoraal akhris',passageInstruction:'Si taxadar leh u akhri sheekada, kadibna ka jawaab su’aalaha soo socda.',passageSection:'Qaybta Koowaad: Faham iyo Hubinta Fahamka',mcqPassageNote:'ka jawaab sheekada kor ku xusan',tos:'Jadwalka Qeexida Imtixaanka (TOS)',itemsLabel:'Su’aalo',weightLabel:'Miisaanka %',qNumbers:'Lambarrada su’aalaha',sectionsLabel:'Qaab-dhismeedka imtixaanka',typeLabel:'Nooca su’aasha',otherLabel:'Kuwa kale (aan mawduuc la xiriirin)',tosPlanned:'Waa qorshaha Blueprint-ka. Lambarrada su’aalaha waxay soo baxayaan marka imtixaanka la sameeyo.',tosActual:'Waxay ku salaysan tahay imtixaanka la sameeyay (lambarrada su’aalaha waxay ku jiraan qaansada).',passagePart1:'Koowaad: Faham — Akhri sheekada kor ku xusan si fiican, kadibna goobo xarafka ka horreeya jawaabta saxda ah adigoo ka kaashanaya sheekada.',passagePart2:'Labaad: Xeerarka Luqadda iyo Qaab-dhismeedka — Goobo xarafka ka horreeya jawaabta saxda ah (tusaalayaashu waxay ka yimaadeen sheekada).',passagePart3:'Saddexaad: Erayada iyo Isku-dhafka Eray — Goobo xarafka ka horreeya jawaabta saxda ah.'},
    ar:{mcq:'القسم الأول — أسئلة الاختيار من متعدد',fill:'القسم الثاني — أكمل الفراغات',matching:'القسم الثالث — المطابقة',structured:'القسم الرابع — الأسئلة المباشرة / المنظمة',name:'الاسم',date:'التاريخ',class:'الصف',total:'الدرجة الكلية',instructions:'التعليمات',answer:'نموذج الإجابة ودليل التصحيح',studentAnswer:'الإجابة',question:'السؤال',answerChoices:'خيارات الإجابة',matchPrompt:'طابق عناصر العمود أ مع الخيارات الصحيحة في العمود ب، واكتب حرف الخيار فقط.',number:'الرقم',columnA:'العمود أ: العناصر',answerLetter:'حرف الإجابة',columnB:'العمود ب: الخيارات / الأوصاف',markingGuide:'الإجابة / دليل التصحيح',notProvided:'لم تُقدَّم إجابة',allQuestions:'أجب عن جميع الأسئلة. اقرأ كل سؤال بعناية.',marks:'درجات',matchingKey:'مفتاح الإجابة',blueprint:'مخطط الاختبار وجدول المواصفات',subjectLabel:'المادة',languageLabel:'اللغة',unitLabel:'الوحدة / الفصل',topicLabel:'الموضوع',outcomesLabel:'نواتج التعلم',bloomLabel:'توزيع بلوم',questionsLabel:'الأسئلة',marksLabel:'الدرجات',pagesLabel:'الصفحات',source:'المصدر',objectiveLabel:'هدف التعلم',questionsDefault:'الأسئلة',passageLabel:'قطعة القراءة',passageInstruction:'اقرأ القطعة التالية بعناية ثم أجب عن الأسئلة التي تليها.',passageSection:'القسم الأول: الفهم والاستيعاب',mcqPassageNote:'باستعانة القطعة السابقة',tos:'جدول المواصفات',itemsLabel:'الأسئلة',weightLabel:'الوزن %',qNumbers:'أرقام الأسئلة',sectionsLabel:'هيكل الاختبار',typeLabel:'نوع السؤال',otherLabel:'أخرى (غير مرتبطة بموضوع)',tosPlanned:'مخطط من المخطط العام. تظهر أرقام الأسئلة بعد إنشاء الاختبار.',tosActual:'بناءً على الاختبار المُنشأ (أرقام الأسئلة بين قوسين).',passagePart1:'أولاً: اقرأ القطعة السابقة جيداً، ثم ضع دائرة حول الحرف الذي يسبق الجواب الصحيح باستعانة القطعة.',passagePart2:'ثانياً: القواعد والأساليب — ضع دائرة حول الحرف الذي يسبق الجواب الصحيح (الأمثلة مأخوذة من القطعة).',passagePart3:'ثالثاً: المفردات والتراكيب — ضع دائرة حول الحرف الذي يسبق الجواب الصحيح.'}
  };
  return (labels[lang]||labels.en)[key]||key;
}


const BLOOM_NAMES={
  en:{Remember:'Remember',Understand:'Understand',Apply:'Apply',Analyze:'Analyze',Evaluate:'Evaluate',Create:'Create'},
  so:{Remember:'Xusuusasho',Understand:'Faham',Apply:'Ku-dhaqan',Analyze:'Falanqayn',Evaluate:'Qiimayn',Create:'Abuurid'},
  ar:{Remember:'تذكّر',Understand:'فهم',Apply:'تطبيق',Analyze:'تحليل',Evaluate:'تقويم',Create:'إبداع'}
};
function bloomName(lang,key){return (BLOOM_NAMES[lang]||BLOOM_NAMES.en)[key]||key;}
function currentExamLang(){const v=document.getElementById('examLanguage')?.value;return ['en','so','ar'].includes(v)?v:'en';}
function defaultExamTitle(lang,subject,className){
  const d={en:['Examination','Class'],so:['Imtixaan','Fasal'],ar:['امتحان','الصف']}[lang]||['Examination','Class'];
  return `${subject||d[0]} — ${className||d[1]}`;
}
// Bloom level is teacher-only metadata: never let a label such as "(Remember)" or "Bloom level: Apply" reach the student paper.
const BLOOM_WORDS_RE='Remember|Understand|Apply|Analy[sz]e|Evaluate|Create|Xusuusasho|Faham|Ku-dhaqan|Falanqayn|Qiimayn|Abuurid|تذكر|تذكّر|فهم|تطبيق|تحليل|تقويم|تقييم|إبداع|ابتكار';
const BLOOM_TAG_RE_UI=new RegExp('\\s*[\\(\\[\\{]\\s*(?:Bloom[^\\)\\]\\}:\\-–]*[:\\-–]\\s*)?(?:'+BLOOM_WORDS_RE+')\\s*[\\)\\]\\}]','giu');
const BLOOM_LINE_RE_UI=/\s*(?:\(|\[)?\s*(?:Bloom(?:['’]s)?(?:\s+(?:level|taxonomy|heerka|نوع|مستوى))?|Heerka Bloom|مستوى بلوم)\s*[:\-–]\s*[^\n)\]]{0,40}(?:\)|\])?/giu;
function noBloom(text){return typeof text==='string'?text.replace(BLOOM_LINE_RE_UI,'').replace(BLOOM_TAG_RE_UI,'').replace(/\s{2,}/g,' ').trim():text;}

function localizeExamSections(questions, lang){
  const sectionMap={
    en:{'QAYBTA I — SU’AALAHA DOORASHADA':'PART I — MULTIPLE CHOICE QUESTIONS','QAYBTA II — MEELAHA BANNAAN':'PART II — FILL IN THE BLANKS','QAYBTA III — ISKU-AADINTA':'PART III — MATCHING','QAYBTA IV — SU’AALAHA TOOSKA AH / QAABAYSAN':'PART IV — DIRECT / STRUCTURED QUESTIONS'},
    so:{'PART I — MULTIPLE CHOICE QUESTIONS':'QAYBTA I — SU’AALAHA DOORASHADA','PART II — FILL IN THE BLANKS':'QAYBTA II — MEELAHA BANNAAN','PART III — MATCHING':'QAYBTA III — ISKU-AADINTA','PART IV — DIRECT / STRUCTURED QUESTIONS':'QAYBTA IV — SU’AALAHA TOOSKA AH / QAABAYSAN'},
    ar:{'PART I — MULTIPLE CHOICE QUESTIONS':'القسم الأول — أسئلة الاختيار من متعدد','PART II — FILL IN THE BLANKS':'القسم الثاني — أكمل الفراغات','PART III — MATCHING':'القسم الثالث — المطابقة','PART IV — DIRECT / STRUCTURED QUESTIONS':'القسم الرابع — الأسئلة المباشرة / المنظمة'}
  };
  const map=sectionMap[lang]||sectionMap.en;
  return (questions||[]).map(q=>({...q,section:map[q.section]||q.section}));
}

function sanitizeDiagramSvg(svg){
  if(!svg||typeof svg!=='string')return '';
  let s=svg.replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<\/?(?:foreignObject|iframe|object|embed|image|use|marker)\b[^>]*>/gi,'')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'')
    .replace(/\s(?:href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'')
    .replace(/url\s*\([^)]*\)/gi,'none');
  return /<svg\b/i.test(s)?s:'';
}

function makePartPlan(totalCount,totalMarks,format,diagramCount,lang='en',passageMode=false){
  const specs = passageMode
    ? [
        {section:examText(lang,'passagePart1'),type:'MCQ',ratio:.4,weight:.4},
        {section:examText(lang,'passagePart2'),type:'MCQ',ratio:.35,weight:.35},
        {section:examText(lang,'passagePart3'),type:'MCQ',ratio:.25,weight:.25}
      ]
    : format==='two-section'
    ? [
         {section:examText(lang,'mcq'),type:'MCQ',ratio:.45,weight:.4},
        {section:examText(lang,'structured'),type:'Structured',ratio:.55,weight:.6}
      ]
    : [
         {section:examText(lang,'mcq'),type:'MCQ',ratio:.455,weight:.2},
        {section:examText(lang,'fill'),type:'Fill in the Blank',ratio:.227,weight:.1},
        {section:examText(lang,'matching'),type:'Matching',ratio:.045,weight:.1},
        {section:examText(lang,'structured'),type:'Structured',ratio:.273,weight:.6}
      ];
  const raw=specs.map(s=>totalCount*s.ratio),counts=raw.map(Math.floor);
  let left=totalCount-counts.reduce((a,b)=>a+b,0);
  raw.map((v,i)=>({i,rem:v-Math.floor(v)})).sort((a,b)=>b.rem-a.rem).forEach((x)=>{if(left>0){counts[x.i]++;left--;}});
  for(let i=0;i<counts.length;i++)if(counts[i]===0){const donor=counts.map((v,j)=>({v,j})).filter(x=>x.v>1).sort((a,b)=>b.v-a.v)[0];if(donor){counts[donor.j]--;counts[i]++;}}
  const rawMarks=specs.map(s=>totalMarks*s.weight),marks=rawMarks.map(Math.floor);
  let markLeft=totalMarks-marks.reduce((a,b)=>a+b,0);
  rawMarks.map((v,i)=>({i,rem:v-Math.floor(v)})).sort((a,b)=>b.rem-a.rem).forEach(x=>{if(markLeft>0){marks[x.i]++;markLeft--;}});
  const plan=specs.map((s,i)=>({...s,count:counts[i],targetMarks:marks[i]}));
  const structured=plan.find(p=>p.type==='Structured');
  if(diagramCount>0&&structured&&diagramCount>structured.count)throw new Error(`Tirada jaantusyada (${diagramCount}) kama badnaan karto su’aalaha Structured (${structured.count}). Kordhi tirada su’aalaha ama yaree jaantusyada.`);
  return plan;
}
function partAtIndex(index,plan){let n=0;for(const p of plan){n+=p.count;if(index<n)return p;}return plan[plan.length-1];}
function applyExactMarks(items,plan,totalMarks){
  items.forEach((q,i)=>{const p=partAtIndex(i,plan);q.section=p.section;q.type=p.type;});
  let offset=0;
  for(const p of plan){const group=items.slice(offset,offset+p.count);offset+=p.count;if(!group.length)continue;const base=Math.floor(p.targetMarks/group.length),extra=p.targetMarks-base*group.length;group.forEach((q,i)=>q.marks=base+(i<extra?1:0));}
  const sum=items.reduce((s,q)=>s+Number(q.marks||0),0);
  if(items.length&&sum!==totalMarks)items[items.length-1].marks+=totalMarks-sum;
  return items;
}
function cleanMatches(q){
  q.matches=Array.isArray(q.matches)?q.matches.map((m,i)=>Array.isArray(m)?{question:String(m[0]||`Item ${i+1}`),answer:String(m[1]||'')}:{question:String(m.question||m.term||m.left||`Item ${i+1}`),answer:String(m.answer||m.match||m.right||'')}):[];
  q.options=Array.isArray(q.options)?q.options:[];
  return q;
}

function isLanguageSubject(subject){
  const t=String(subject||'').toLowerCase();
  return /arabic|carabi|arabi|عرب|لغة|لغه|lugha|luuqad|luqad|english|ingiriis|af[\s-]*(soomaali|carabi|ingiriis)|somali\s*language|literature|suugaan|أدب|nahw|naxwe|grammar/.test(t);
}
function resolvePassageMode(subject){
  const v=document.getElementById('genPassage')?.value||'auto';
  return v==='yes'||(v==='auto'&&isLanguageSubject(subject));
}
function examBlueprintKey(id,start,end,totalMarks,count,format,examLanguage,levels){return JSON.stringify({id,start,end,totalMarks,count,format,examLanguage,levels,passage:document.getElementById('genPassage')?.value||'auto',subject:($('genSubject')?.value||'').trim()});}
function blueprintTableHtml(blueprint,lang){
  return blueprintMainHtml(blueprint,lang)+tosTableHtml(blueprint,lang)+sectionTableHtml(blueprint,lang);
}
// Paper numbering: all matching questions are merged into ONE numbered block (see paperQuestionsHtml).
function paperNumbers(qs){
  const first=qs.find(x=>x.type==='Matching');
  let n=0,firstNo=0;
  return qs.map(x=>{
    if(x.type==='Matching'){if(x===first)firstNo=++n;return firstNo;}
    return ++n;
  });
}
function computeTos(bp,qs){
  if(!bp||!Array.isArray(bp.coverage)||!Array.isArray(qs))return;
  const norm=s=>String(s||'').replace(/\s+/g,' ').trim().toLowerCase();
  const nums=paperNumbers(qs);
  const rows=bp.coverage.map(()=>({levels:{},marks:0}));
  const other={levels:{},marks:0};
  const outcomeText=o=>typeof o==='string'?o:(o?.text||o?.objective||'');
  qs.forEach((q,i)=>{
    const lv=blooms.includes(q.level)?q.level:(blooms.includes(q.bloom)?q.bloom:'Understand');
    const obj=norm(q.objective);
    let idx=obj?bp.coverage.findIndex(r=>(r.learningOutcomes||[]).some(o=>norm(outcomeText(o))===obj)):-1;
    if(idx<0){const t=norm(q.topic);if(t)idx=bp.coverage.findIndex(r=>norm(r.topic)===t);}
    const tgt=idx>=0?rows[idx]:other;
    const list=(tgt.levels[lv]=tgt.levels[lv]||[]);
    if(!list.includes(nums[i]))list.push(nums[i]);
    tgt.marks+=Number(q.marks)||0;
  });
  bp.tos={rows,other:Object.keys(other.levels).length?other:null,questionCount:qs.length,blockCount:new Set(nums).size};
}
function tosTableHtml(bp,lang){
  const cov=Array.isArray(bp?.coverage)?bp.coverage:[];
  if(!cov.length)return '';
  const tos=(bp.tos&&Array.isArray(bp.tos.rows)&&bp.tos.rows.length===cov.length)?bp.tos:null;
  const lvCount=(r,k)=>r?((r.levels||{})[k]||[]).length:0;
  const planned=(row,k)=>Number(row.bloomDistribution?.[k])||0;
  const itemsOf=(row,i)=>tos?blooms.reduce((n,k)=>n+lvCount(tos.rows[i],k),0):(Number(row.questionCount)||0);
  const marksOf=(row,i)=>tos?(Number(tos.rows[i]?.marks)||0):(Number(row.marks)||0);
  const cellHtml=(row,i,k)=>{
    if(tos){const nums=(tos.rows[i]?.levels||{})[k]||[];return nums.length?`<b>${nums.length}</b><div class="tos-nums">(${nums.slice().sort((a,b)=>a-b).join(', ')})</div>`:'·';}
    const n=planned(row,k);return n?`<b>${n}</b>`:'·';
  };
  const colCount=k=>cov.reduce((n,row,i)=>n+(tos?lvCount(tos.rows[i],k):planned(row,k)),0)+(tos&&tos.other?lvCount(tos.other,k):0);
  const totalItems=blooms.reduce((n,k)=>n+colCount(k),0)||Number(bp.totalQuestions)||0;
  const totalMarks=tos?(cov.reduce((n,row,i)=>n+marksOf(row,i),0)+(tos.other?Number(tos.other.marks)||0:0)):(Number(bp.totalMarks)||cov.reduce((n,r)=>n+(Number(r.marks)||0),0));
  const pct=(v,t)=>t?(Math.round(v/t*1000)/10)+'%':'0%';
  const head=`<tr><th>${examText(lang,'topicLabel')}</th>${blooms.map(k=>`<th class="num">${esc(bloomName(lang,k))}</th>`).join('')}<th class="num">${examText(lang,'itemsLabel')}</th><th class="num">${examText(lang,'marksLabel')}</th><th class="num">${examText(lang,'weightLabel')}</th></tr>`;
  const body=cov.map((row,i)=>`<tr><td>${esc(row.topic||row.unit||'')}${row.unit&&row.topic?`<div class="tos-unit">${esc(row.unit)}</div>`:''}</td>${blooms.map(k=>`<td class="num">${cellHtml(row,i,k)}</td>`).join('')}<td class="num"><b>${itemsOf(row,i)}</b></td><td class="num">${marksOf(row,i)}</td><td class="num">${pct(marksOf(row,i),totalMarks)}</td></tr>`).join('');
  const otherRow=(tos&&tos.other)?`<tr><td>${examText(lang,'otherLabel')}</td>${blooms.map(k=>{const nums=(tos.other.levels||{})[k]||[];return `<td class="num">${nums.length?`<b>${nums.length}</b><div class="tos-nums">(${nums.join(', ')})</div>`:'·'}</td>`;}).join('')}<td class="num"><b>${blooms.reduce((n,k)=>n+lvCount(tos.other,k),0)}</b></td><td class="num">${Number(tos.other.marks)||0}</td><td class="num">${pct(Number(tos.other.marks)||0,totalMarks)}</td></tr>`:'';
  const foot=`<tr class="bp-total"><td>${examText(lang,'total')}</td>${blooms.map(k=>`<td class="num">${colCount(k)}</td>`).join('')}<td class="num">${totalItems}</td><td class="num">${totalMarks}</td><td class="num">100%</td></tr><tr class="tos-pct"><td>${examText(lang,'weightLabel')}</td>${blooms.map(k=>`<td class="num">${pct(colCount(k),totalItems)}</td>`).join('')}<td colspan="3"></td></tr>`;
  return `<h3 class="tos-title">${esc(examText(lang,'tos'))}</h3><div class="table-wrap bp-wrap"><table class="bp-table tos-table"><colgroup><col class="c-tos-topic">${blooms.map(()=>'<col class="c-tos-lv">').join('')}<col class="c-tos-n"><col class="c-tos-n"><col class="c-tos-n"></colgroup><thead>${head}</thead><tbody>${body}${otherRow}${foot}</tbody></table></div><p class="muted">${esc(examText(lang,tos?'tosActual':'tosPlanned'))}</p>`;
}
function sectionTableHtml(bp,lang){
  const sd=Array.isArray(bp?.sectionDistribution)?bp.sectionDistribution:[];
  if(!sd.length)return '';
  const showMarks=sd.some(x=>Number(x.marks)>0);
  const rows=sd.map((x,i)=>`<tr><td class="num">${i+1}</td><td>${esc(x.section||'')}</td><td>${esc(x.type||'')}</td><td class="num">${Number(x.questionCount)||0}</td>${showMarks?`<td class="num">${Number(x.marks)||0}</td>`:''}</tr>`).join('');
  return `<h3 class="tos-title">${esc(examText(lang,'sectionsLabel'))}</h3><div class="table-wrap bp-wrap"><table class="bp-table sec-table"><thead><tr><th class="num">#</th><th>${examText(lang,'sectionsLabel')}</th><th>${examText(lang,'typeLabel')}</th><th class="num">${examText(lang,'itemsLabel')}</th>${showMarks?`<th class="num">${examText(lang,'marksLabel')}</th>`:''}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function blueprintMainHtml(blueprint,lang){
  return `<div class="table-wrap bp-wrap"><table class="bp-table"><colgroup><col class="c-unit"><col class="c-topic"><col class="c-obj"><col class="c-bloom"><col class="c-num"><col class="c-num"><col class="c-pages"></colgroup><thead><tr><th>${examText(lang,'unitLabel')}</th><th>${examText(lang,'topicLabel')}</th><th>${examText(lang,'outcomesLabel')}</th><th>${examText(lang,'bloomLabel')}</th><th class="num">${examText(lang,'questionsLabel')}</th><th class="num">${examText(lang,'marksLabel')}</th><th>${examText(lang,'pagesLabel')}</th></tr></thead><tbody>${(blueprint.coverage||[]).map(x=>`<tr><td>${esc(x.unit||'')}</td><td>${esc(x.topic||'')}</td><td><ul class="bp-obj">${(x.learningOutcomes||[]).map(o=>`<li>${esc(typeof o==='string'?o:(o?.text||o?.objective||''))}</li>`).join('')}</ul></td><td>${Object.entries(x.bloomDistribution||{}).filter(([,v])=>Number(v)>0).map(([k,v])=>`<span class="bp-chip">${esc(bloomName(lang,k))}: ${Number(v)}</span>`).join('')}</td><td class="num">${Number(x.questionCount)||0}</td><td class="num">${Number(x.marks)||0}</td><td>${esc(x.sourcePages||'')}</td></tr>`).join('')}<tr class="bp-total"><td colspan="4">${examText(lang,'total')}</td><td class="num">${(blueprint.coverage||[]).reduce((n,x)=>n+(Number(x.questionCount)||0),0)}</td><td class="num">${(blueprint.coverage||[]).reduce((n,x)=>n+(Number(x.marks)||0),0)}</td><td></td></tr></tbody></table></div>`;
}
function renderExamBlueprint(blueprint,validation){
  if(validation)lastBlueprintValidation=validation;
  const el=$('examBlueprintPreview');
  if(!blueprint){el.innerHTML='';return;}
  const lang=document.getElementById('examLanguage')?.value||'en';
  el.innerHTML=`<div class="item"><strong>${examText(lang,'blueprint')}</strong><p>${examText(lang,'subjectLabel')}: ${esc(blueprint.subject||'')} · ${examText(lang,'languageLabel')}: ${esc(blueprint.language||'')} · ${examText(lang,'total')}: ${Number(blueprint.totalMarks)||0} ${examText(lang,'marks')} · ${Number(blueprint.totalQuestions)||0} ${examText(lang,'questionsLabel').toLowerCase()}</p><p>${lang==='ar'?'التحقق':lang==='so'?'Hubin':'Validation'}: ${validation?.marksMatch?'✅ '+(lang==='ar'?'الدرجات صحيحة':lang==='so'?'Dhibcaha waa sax':'Marks valid'):'⚠️ '+(lang==='ar'?'تحقق من الدرجات':lang==='so'?'Hubi dhibcaha':'Check marks')} · ${validation?.questionsMatch?'✅ '+(lang==='ar'?'عدد الأسئلة صحيح':lang==='so'?'Tirada su’aalaha waa sax':'Question count valid'):'⚠️ '+(lang==='ar'?'تحقق من العدد':lang==='so'?'Hubi tirada':'Check count')}</p></div>${blueprintTableHtml(blueprint,lang)}<p class="muted">${lang==='ar'?'تم إعداد المخطط من نصوص الصفحات المحددة المستخرجة بتقنية OCR. يرجى مراجعة الموضوعات ونواتج التعلم للتأكد من توافقها مع المنهج.':lang==='so'?'Blueprint-kan AI ayaa ka sameeyey qoraalka OCR ee bogagga la doortay. Macallinku ha xaqiijiyo in mawduucyada iyo ujeeddooyinka waxbarashadu waafaqsan yihiin manhajka.':'This blueprint was generated from OCR text on the selected pages. Review topics and learning outcomes for curriculum alignment.'}</p>`;
  el.insertAdjacentHTML('beforeend',`<div class="paper-tools no-print"><button id="saveBlueprint" class="green">💾 Keydi Blueprint</button><button id="printBlueprint" class="secondary">🖨️ Daabac Blueprint</button></div>`);
  $('saveBlueprint').onclick=saveCurrentBlueprint;
  $('printBlueprint').onclick=()=>printBlueprintDoc(currentExamBlueprint||blueprint,lang);
}
const BP_STORE='ghdd_blueprints';
function loadSavedBlueprints(){try{const v=JSON.parse(localStorage.getItem(BP_STORE)||'[]');return Array.isArray(v)?v:[];}catch(_){return [];}}
function schoolNameFor(lang){return lang==='ar'?'مجلس تطوير المدارس الحكومية (GHDD)':lang==='en'?'Public Schools Development Council (GHDD)':'Golaha Horumarinta Dugsiyada Dadweynaha (GHDD)';}
async function saveCurrentBlueprint(){
  const status=$('examBlueprintStatus');
  if(!currentExamBlueprint){alert('Marka hore samee Blueprint.');return;}
  const lang=currentExamLang();
  const subject=($('genSubject').value||'').trim()||currentExamBlueprint.subject||'';
  const className=($('genClass').value||'').trim();
  const entry={id:uid(),title:`Blueprint — ${subject||'—'}${className?' — '+className:''}`,subject,className,lang,savedAt:new Date().toISOString(),blueprint:JSON.parse(JSON.stringify(currentExamBlueprint))};
  const list=loadSavedBlueprints();list.unshift(entry);
  try{localStorage.setItem(BP_STORE,JSON.stringify(list.slice(0,50)));}catch(e){alert('Browser-ka kaydin ma suurtagalin: '+e.message);return;}
  renderSavedBlueprints();
  try{
    const savedBp=await api('/api/assessments',{method:'POST',body:JSON.stringify({title:entry.title,subject,klass:className,totalMarks:Number(entry.blueprint.totalMarks)||0,school:'GHDD',blueprint:entry.blueprint,data:{kind:'blueprint',language:lang}})});
    try{const all=loadSavedBlueprints();const me=all.find(x=>x.id===entry.id);if(me){me.databaseId=savedBp.id;localStorage.setItem(BP_STORE,JSON.stringify(all));}}catch(_){}
    status.textContent='Blueprint-ka waa la keydiyay (PostgreSQL iyo browser-ka). Waxaad ka heli doontaa tabka 🗂️ Dashboard.';
  }catch(e){
    status.textContent='Blueprint-ka waxaa lagu keydiyay browser-ka; database-ka lama keydin: '+e.message;
  }
}
function printBlueprintDoc(bp,lang){
  if(!bp)return alert('Marka hore samee Blueprint.');
  const root=$('printBpRoot');
  const rtl=lang==='ar'?'dir="rtl" lang="ar"':'';
  const subject=($('genSubject').value||'').trim()||bp.subject||'';
  const className=($('genClass').value||'').trim();
  const rules=(bp.qualityRules||[]).map(r=>`<li>${esc(r)}</li>`).join('');
  root.innerHTML=`<div ${rtl}><div class="paper-head"><img class="exam-logo" src="/letterhead.jpg" alt="GHDD logo"><h1>${esc(schoolNameFor(lang))}</h1><h2>${esc(examText(lang,'blueprint'))}</h2><p>${esc(subject)}${className?' · '+esc(className):''}</p></div><p>${examText(lang,'subjectLabel')}: ${esc(bp.subject||subject)} · ${examText(lang,'languageLabel')}: ${esc(bp.language||'')} · ${examText(lang,'total')}: ${Number(bp.totalMarks)||0} ${examText(lang,'marks')} · ${Number(bp.totalQuestions)||0} ${examText(lang,'questionsLabel').toLowerCase()}</p>${blueprintTableHtml(bp,lang)}${rules?`<ul class="bp-rules">${rules}</ul>`:''}</div>`;
  document.body.classList.add('print-bp');
  window.print();
  setTimeout(()=>document.body.classList.remove('print-bp'),700);
}
function renderSavedBlueprints(){
  const el=$('savedBlueprints');if(!el)return;
  const list=loadSavedBlueprints();
  if(!list.length){el.innerHTML='';return;}
  el.innerHTML='<h3>Blueprint-yada la keydiyay</h3>'+list.map(x=>`<div class="item"><b>${esc(x.title)}</b><p class="muted">${esc(new Date(x.savedAt).toLocaleString())} · ${Number(x.blueprint?.totalMarks)||0} · ${(x.blueprint?.coverage||[]).length}</p><div class="paper-tools no-print"><button class="secondary" data-bp-open="${x.id}">Fur</button><button class="secondary" data-bp-print="${x.id}">Daabac</button><button class="danger" data-bp-del="${x.id}">Tir</button></div></div>`).join('');
  const find=id=>loadSavedBlueprints().find(x=>x.id===id);
  el.querySelectorAll('[data-bp-open]').forEach(b=>b.onclick=()=>{const x=find(b.dataset.bpOpen);if(!x)return;currentExamBlueprint=x.blueprint;currentExamBlueprintKey='';const sel=$('examLanguage');if(sel&&x.lang)sel.value=x.lang;renderExamBlueprint(x.blueprint,{marksMatch:true,questionsMatch:true});});
  el.querySelectorAll('[data-bp-print]').forEach(b=>b.onclick=()=>{const x=find(b.dataset.bpPrint);if(x)printBlueprintDoc(x.blueprint,x.lang||currentExamLang());});
  el.querySelectorAll('[data-bp-del]').forEach(b=>b.onclick=()=>{if(!confirm('Ma tirtirtaa Blueprint-kan?'))return;localStorage.setItem(BP_STORE,JSON.stringify(loadSavedBlueprints().filter(x=>x.id!==b.dataset.bpDel)));renderSavedBlueprints();});
}
async function requestExamBlueprint(sourceText,p){
  const d=await api('/api/blueprint',{method:'POST',body:JSON.stringify({...p,sourceText})});
  currentExamBlueprint=d.blueprint;
  currentExamBlueprintKey=p.blueprintKey;
  renderExamBlueprint(d.blueprint,d.validation);
  return d.blueprint;
}
$('makeExamBlueprint').onclick=async()=>{
  const id=$('sourceBook').value, start=Number($('startPage').value), end=Number($('endPage').value);
  const totalMarks=Number($('genTotalMarks').value)||100;
  const countText=$('genCount').value.trim(), count=countText===''?null:Number(countText);
  const levels=Array.from($('genLevels').selectedOptions).map(o=>o.value);
  const diagramCount=Number($('diagramCount').value), format=$('genFormat').value;
  const chosen=document.getElementById('examLanguage')?.value||'en';
  if(!id)return alert('Marka hore dooro buugga OCR.');
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start)return alert('Hubi bogagga bilowga iyo dhammaadka.');
  const status=$('examBlueprintStatus'); status.textContent='AI ayaa aqoonsanaya cutubyada, topics-ka, learning outcomes-ka iyo qaybinta marks-ka...';
  try{
    const d=await api(`/api/books/${encodeURIComponent(id)}/text?start=${start}&end=${end}`,{method:'GET'});
    const sourceText=(d.pages||[]).filter(p=>p.text&&p.text.trim()).map(p=>`[PAGE ${p.page}]\n${p.text}`).join('\n\n--- PAGE BREAK ---\n\n');
    if(!sourceText.trim())throw new Error('Qoraal OCR ah lagama helin bogagga la doortay.');
    const book=books.find(b=>String(b.id)===String(id));
    const subject=$('genSubject').value.trim()||$('bookSubject').value.trim()||book?.subject||'';
    const className=$('genClass').value.trim();
    const effectiveCount=count===null?Math.min(50,Math.max(10,Math.round(totalMarks*.44))):count;
    const lang=chosen;
    const partPlan=makePartPlan(effectiveCount,totalMarks,format,diagramCount,lang);
    const key=examBlueprintKey(id,start,end,totalMarks,effectiveCount,format,chosen,levels);
    const usePassageBp=resolvePassageMode(subject);
    const bp=await requestExamBlueprint(sourceText,{subject,className,sourceTitle:d.title,pageRange:{start,end},totalMarks,count:effectiveCount,format,diagramCount:usePassageBp?0:diagramCount,partPlan,levels,examLanguage:chosen,passage:usePassageBp,blueprintKey:key});
    status.textContent=`Blueprint waa diyaar: ${bp.coverage.length} mawduuc ayaa la aqoonsaday.`;
  }catch(e){status.textContent='Khalad: '+e.message;alert('AI Blueprint: '+e.message);}
};

$('generateExam').onclick=async()=>{
  const id=$('sourceBook').value;
  const start=Number($('startPage').value);
  const end=Number($('endPage').value);
  const countText=$('genCount').value.trim();
  const count=countText===''?null:Number(countText);
  const totalMarks=Number($('genTotalMarks').value)||100;
  const levels=Array.from($('genLevels').selectedOptions).map(o=>o.value);
  const diagramCount=Number($('diagramCount').value);
  if(!id)return alert('Dooro buug.');
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start)
    return alert('Hubi bogga bilowga iyo dhammaadka.');
  if(count!==null&&(!Number.isInteger(count)||count<4||count>50))return alert('Qaabka afarta qaybood ah, tirada su’aaluhu waa 4 ilaa 50; ama madhan uga tag.');
  if(!Number.isInteger(totalMarks)||totalMarks<10||totalMarks>300)return alert('Wadarta dhibcuhu waa inay u dhexaysaa 10 ilaa 300.');
  if(!Number.isInteger(diagramCount)||diagramCount<0||diagramCount>30)return alert('Tirada jaantusyadu waa 0 ilaa 30.');
  if(!levels.length)return alert('Dooro ugu yaraan hal heer Bloom.');
  const effectiveCount=count===null?Math.min(50,Math.max(10,Math.round(totalMarks*0.44))):count;
  const format=$('genFormat').value;
  let partPlan;
  try{partPlan=makePartPlan(effectiveCount,totalMarks,format,diagramCount);}
  catch(planError){return alert(planError.message);}

  const status=$('generateStatus');
  const out=$('generatedQuestions');
  status.textContent='Qoraalka bogagga ayaa la soo rarayaa...';
  out.innerHTML='';

  try{
    const d=await api(`/api/books/${encodeURIComponent(id)}/text?start=${start}&end=${end}`,{method:'GET'});
    const selected=(d.pages||[]).filter(p=>p.text&&p.text.trim());
    const sourceText=selected.map(p=>`[BOGGA ${p.page} — QORAALKA BOGGAN]\n${p.text}`).join('\n\n--- DHAMMAADKA BOGGA ---\n\n');
     const detectedLanguage=detectExamLanguage(sourceText);
     const chosenExamLanguage=(document.getElementById('examLanguage')?.value||'en');
     const examLanguage=chosenExamLanguage;
     const book=books.find(b=>String(b.id)===String(id));
     const subject=$('genSubject').value.trim()||$('bookSubject').value.trim()||book?.subject||'';
     const className=$('genClass').value.trim();
     const usePassage=resolvePassageMode(subject);
     const diagramCountUsed=usePassage?0:diagramCount;
     partPlan=makePartPlan(effectiveCount,totalMarks,format,diagramCountUsed,examLanguage);
     if(usePassage){const mcqPart=partPlan.find(x=>x.type==='MCQ');if(mcqPart)mcqPart.section=`${mcqPart.section} — ${examText(examLanguage,'mcqPassageNote')}`;}
    if(!sourceText.trim())throw new Error('Qoraal lagama helin bogagga la doortay.');

    const blueprintKeyNow=examBlueprintKey(id,start,end,totalMarks,effectiveCount,format,chosenExamLanguage,levels);
    if(!currentExamBlueprint || currentExamBlueprintKey!==blueprintKeyNow){
      status.textContent='Tallaabada 1/2: AI ayaa marka hore samaynaya Exam Blueprint...';
      const bp=await requestExamBlueprint(sourceText,{subject,className,sourceTitle:d.title,pageRange:{start,end},totalMarks,count:effectiveCount,format,diagramCount:diagramCountUsed,partPlan,levels,examLanguage,passage:usePassage,blueprintKey:blueprintKeyNow});
      if(!bp)throw new Error('Blueprint lama samayn.');
    }
    status.textContent='Tallaabada 2/2: AI ayaa Blueprint-ka raacaya si uu u sameeyo su’aalaha...';

    const generated=await api('/api/generate',{
      method:'POST',
      body:JSON.stringify({
        sourceText,subject,className,count:effectiveCount,questionCount:effectiveCount,
        totalMarks,format,diagramCount:diagramCountUsed,passage:usePassage,passageTheme:(($('genPassageTheme')||{}).value||''),partPlan,blueprint:currentExamBlueprint,levels,type:'Isku-dhafan',sourceSelectionRule:'Spread questions across different headings/topics. Do not take consecutive questions from the same paragraph or same heading. Prefer passages separated by at least two headings or at least one full page. Record source pages and topic/heading for each question.',examLanguage,
        sourceTitle:d.title,
        pageRange:{start,end}
      })
    });

    let qs=generated.questions||[];
    const passage=(usePassage&&generated.passage&&String(generated.passage.text||'').trim())?generated.passage:null;
    if(usePassage&&!passage)throw new Error('AI ma soo celin passage (sheeko). Isku day mar kale.');
     if(!qs.length)throw new Error('AI ma soo celin su’aalo.');
     if(qs.length<effectiveCount)throw new Error(`AI-gu wuxuu soo celiyey ${qs.length} su’aalood halkii laga rabay ${effectiveCount}. Isku day mar kale ama yaree tirada su’aalaha.`);
     qs=qs.slice(0,effectiveCount).map(q=>cleanMatches(q));
     qs=applyExactMarks(qs,partPlan,totalMarks);
     // Diagrams come only from the AI-made SVG (diagramSvg). No hard-coded placeholder text is ever put on the paper.
     qs.forEach(q=>{q.diagram='';});
    const lang=examLanguage;
    const examTitle=$('examName').value.trim()||defaultExamTitle(lang,subject,className);
    const schoolName=lang==='ar'?'مجلس تطوير المدارس الحكومية (GHDD)':lang==='en'?'Public Schools Development Council (GHDD)':'Golaha Horumarinta Dugsiyada Dadweynaha (GHDD)';
    const normalized=qs.map((q,i)=>({
      id:uid(),
      text:noBloom(q.question||q.text||''),
      marks:Number(q.marks)||1,
      level:q.bloom||q.level||'Understand',
      answer:noBloom(q.answer||q.modelAnswer||''),
      objective:noBloom(q.objective||''),
      topic:q.topic||`${d.title} bogagga ${start}-${end}`,
      type:q.type||'Structured',
      section:q.section||'',
      options:Array.isArray(q.options)?q.options.map(o=>noBloom(String(o))):[],
      matches:Array.isArray(q.matches)?q.matches.map(m=>({...m,question:noBloom(String(m?.question||'')),answer:noBloom(String(m?.answer||''))})):[],
      diagram:q.diagram||'',diagramSvg:q.diagramSvg||'',
      distractor:noBloom(String(q.distractor||'')),
      keyPoints:Array.isArray(q.keyPoints)?q.keyPoints.map(x=>noBloom(String(x&&typeof x==='object'?(x.point||x.text||''):x||''))).filter(Boolean):[],
      sourcePages:q.sourcePages||''
    }));
    // The generated questions are added automatically; no per-question "add" step is required.
    questions=normalized;
    $('examName').value=examTitle;
    $('subject').value=subject;
    $('className').value=className;
    renderQuestions();

    const renderPaperQuestions=(withAnswers)=>paperQuestionsHtml(normalized,passage,lang,withAnswers,isMathSubjectClient(subject));
    const total=buildPrintRoot({lang,examTitle,subject,className,normalized,passage,instructions:$('examInstructions').value});
    lastGenerated={lang,passage};
    if(currentExamBlueprint&&Array.isArray(currentExamBlueprint.coverage)){computeTos(currentExamBlueprint,normalized);renderExamBlueprint(currentExamBlueprint,lastBlueprintValidation||{marksMatch:true,questionsMatch:true});}
    let preflight={average:0,questions:[],status:'Hubinta tayada lama helin'};
    try{preflight=await api('/api/quality-check',{method:'POST',body:JSON.stringify({questions:qs})});}catch(checkError){console.warn('Quality pre-check unavailable:',checkError.message);}
    const traceable=normalized.filter(q=>String(q.sourcePages||'').trim()).length;
    const topicsCovered=new Set(normalized.map(q=>String(q.topic||'').trim()).filter(Boolean)).size;
    const qualityIssues=(preflight.questions||[]).reduce((n,q)=>n+(q.quality?.issues?.length||0),0);
    const objCov=generated.objectiveCoverage||{total:0,covered:0,percent:0,uncovered:[]};
    const langCheck=generated.languageCheck||{fixed:0,remaining:0};
    const qualityHtml=`<div class="panel"><h3>📊 Exam Quality Report — Preliminary</h3><div class="grid"><div class="stat"><b>${Number(preflight.average)||0}/100</b><br>Question quality score</div><div class="stat"><b>${Math.round(traceable/Math.max(1,normalized.length)*100)}%</b><br>Source traceability</div><div class="stat"><b>${topicsCovered}</b><br>Topics represented</div><div class="stat"><b>${objCov.total?objCov.percent+'%':'—'}</b><br>Objectives covered (${objCov.covered}/${objCov.total})</div><div class="stat"><b>${qualityIssues}</b><br>Automated issues to review</div></div>${objCov.uncovered&&objCov.uncovered.length?`<p class="muted"><strong>Objectives aan weli su’aal lahayn:</strong> ${objCov.uncovered.map(esc).join(' · ')}. Kordhi tirada su’aalaha ama dib u samee imtixaanka si loo daboolo.</p>`:''}${langCheck.remaining?`<p class="muted">⚠️ ${Number(langCheck.remaining)} su’aalood waxay laga yaabaa inay weli ku jiraan erayo luqad kale ah; dib u eeg ka hor daabacaadda.</p>`:''}<p><strong>Blueprint coverage:</strong> ${(currentExamBlueprint?.coverage||[]).length} topics · ${Number(currentExamBlueprint?.totalMarks)||total} planned marks · ${Number(currentExamBlueprint?.totalQuestions)||normalized.length} planned questions.</p><p class="muted">Warbixintani waa hubin hordhac ah; macallinku waa inuu xaqiijiyaa saxnaanta aqooneed, jawaabaha iyo waafaqsanaanta manhajka ka hor daabacaadda.</p>${(preflight.questions||[]).map((q,idx)=>({q,idx})).filter(x=>x.q.quality?.issues?.length).slice(0,10).map(x=>`<p>Q${x.idx+1}: ${esc((x.q.quality.issues||[]).join('; '))}</p>`).join('')}</div>`;
    out.innerHTML=`<div class="notice"><strong>Imtixaanka oo dhammaystiran ayaa diyaar ah.</strong><br>Wadarta dhibcaha: ${total}/${total}. Su’aalaha si toos ah ayaa loogu daray imtixaanka; looma baahna inaad mid-mid u riixdo.<br>Dib u eeg su’aalaha, kadib dooro daabacaadda imtixaanka ama answer key-ga.</div>
      <div class="paper-tools no-print"><button class="green word-dl" data-which="exam">📄 Word .docx — Imtixaanka</button><button class="green word-dl" data-which="key">📄 Word .docx — Answer key</button><button class="green word-dl" data-which="both">📄 Word .docx — Labadaba</button><button id="previewPrintExam" class="secondary">🖨️ Daabac imtixaanka</button><button id="previewPrintKey" class="secondary">🔑 Daabac answer key</button><button id="previewPrintBoth" class="secondary">Daabac labadaba</button><button id="saveGeneratedExam" class="green">💾 Keydi imtixaanka</button></div>
      <div class="item"><strong>${esc(examTitle)}</strong><p>${esc(subject)} · ${esc(className)} · ${total} dhibcood · ${normalized.length} su’aalood</p><p>Su’aalaha si toos ah ayaa loogu daray imtixaanka.</p></div>${qualityHtml}${passage?`<div class="passage-block" ${lang==='ar'?'dir="rtl"':''}><div class="passage-head">${esc(examText(lang,'passageLabel'))}</div>${passage.title?`<p class="passage-title">${esc(passage.title)}</p>`:''}<div class="passage-body">${String(passage.text).split(/\n+/).filter(x=>x.trim()).map(x=>`<p>${esc(x)}</p>`).join('')}</div></div>`:''}${(passage&&passage.anchors&&passage.anchors.length)?`<details class="item"><summary>🎯 Objectives-ka ku dhex jira sheekada (macallinka kaliya)</summary>${passage.anchors.map(a=>`<p><b>${esc(a.objective)}</b>: ${esc(a.example)}</p>`).join('')}</details>`:''}<h3>Dib u eeg su’aalaha (heerka Bloom macallinka ayaa arka; marka la daabacayo waa libdhaa)</h3><div class="list">${questionCardsHtml(lang,false)}</div>`;
    $('previewPrintExam').onclick=()=>printSelection('exam');
    $('previewPrintKey').onclick=()=>printSelection('key');
    $('previewPrintBoth').onclick=()=>printSelection('both');
    $('saveGeneratedExam').onclick=saveExamPackage;

        status.textContent=`Guul! ${qs.length} su’aalood ayaa laga sameeyey bogagga ${start}–${end}. Dib u eeg su’aalaha iyo jawaabaha.`;
  }catch(e){
    status.textContent='Khalad: '+e.message;
    alert('Samaynta imtixaanka: '+e.message);
  }
};


// ---------- Math typesetting for the printed paper (stacked fractions, radicals with overline) ----------
function isMathSubjectClient(subject){return /xisaab|math|رياضيات|حساب|algebra|geometry|joometri|هندسة|جبر/i.test(String(subject||''));}
function mathHtml(escaped){
  let t=String(escaped);
  // radicals: √(expr), √number, √letter  ->  √ with a bar over the radicand
  t=t.replace(/([∛∜]|√)\(([^()]+)\)/g,(m,r,x)=>`<span class="rad">${r}<span class="rad-in">${x}</span></span>`);
  t=t.replace(/([∛∜]|√)(\d+(?:\.\d+)?[²³]?|[A-Za-zπ][²³]?)/g,(m,r,x)=>`<span class="rad">${r}<span class="rad-in">${x}</span></span>`);
  // stacked fractions: 3/4, x/2, (x+1)/2 ; letters/letters stay as units (m/s, km/h)
  const op='(\\d+(?:\\.\\d+)?[²³]?|[A-Za-z]{1,2}[²³]?|\\([^()<>]+\\))';
  const re=new RegExp('(?<![\\p{L}\\p{N}/>])'+op+'/'+op+'(?![\\p{L}\\p{N}/])','gu');
  t=t.replace(re,(m,a,b)=>{
    if(!/[\d(]/.test(a+b))return m;
    const strip=x=>x.startsWith('(')&&x.endsWith(')')?x.slice(1,-1):x;
    return `<span class="frac"><span class="num">${strip(a)}</span><span class="den">${strip(b)}</span></span>`;
  });
  return t;
}
function fillWordBox(group,lang){
  // Word box = every correct answer + the distractors, in a fixed pseudo-random order (same on paper and key).
  const words=[];
  group.forEach(g=>{const a=String(g.answer||'').trim();if(a&&!words.includes(a))words.push(a);});
  const answers=new Set(words);
  const extra=[];
  group.forEach(g=>{const d=String(g.distractor||'').trim();if(d&&!answers.has(d)&&!extra.includes(d))extra.push(d);});
  const all=words.slice();
  let seed=0;all.forEach(w=>{for(const c of w)seed=(seed*31+c.codePointAt(0))>>>0;});
  const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let i=all.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[all[i],all[j]]=[all[j],all[i]];}
  return all;
}
function fillBlankHtml(text,answer,withAnswers){
  // Every kind of blank the AI may write becomes one clean blank on the line.
  let t=String(text||'').replace(/_{2,}|\.{4,}|…{2,}|\[\s{2,}\]|\(\s{3,}\)|\[\s*\.{2,}\s*\]|\(\s*\.{2,}\s*\)/g,'\u0001');
  if(!t.includes('\u0001'))t=t.replace(/\s*$/,' \u0001');
  const parts=esc(t).split('\u0001');
  const blank=withAnswers?`<span class="fill-blank filled">${esc(answer||'')}</span>`:'<span class="fill-blank"></span>';
  return parts[0]+blank+parts.slice(1).join('<span class="fill-blank"></span>');
}


// ---------- Answer-key helpers: MCQ letter grid, fill grid, key points with marks ----------
function mcqLetter(q){
  const ans=String(q.answer||'').trim();
  if(/^[A-Da-d]$/.test(ans))return ans.toUpperCase();
  const m=ans.match(/^\(?([A-D])[\).:]\s/);
  if(m)return m[1];
  const norm=s=>String(s).replace(/^[A-D][\).:]\s*/i,'').replace(/\s+/g,' ').trim().toLowerCase();
  const i=(Array.isArray(q.options)?q.options:[]).findIndex(o=>norm(o)===norm(ans));
  return i>=0?String.fromCharCode(65+i):'';
}
function keyGridHtml(items,cols){
  // items: [{no,val}] -> compact boxes "1 | A", `cols` pairs per row
  const rows=[];
  for(let i=0;i<items.length;i+=cols){
    const slice=items.slice(i,i+cols);
    while(slice.length<cols)slice.push(null);
    rows.push('<tr>'+slice.map(x=>x?`<td class="kg-no">${x.no}</td><td class="kg-val">${x.val}</td>`:'<td class="kg-no kg-empty"></td><td class="kg-val kg-empty"></td>').join('')+'</tr>');
  }
  return `<table class="key-grid"><tbody>${rows.join('')}</tbody></table>`;
}
function allocKeyPoints(q){
  // Spread the question marks over its key points (each point gets at least 1 mark, total = question marks).
  const pts=(Array.isArray(q.keyPoints)?q.keyPoints:[]).map(x=>String(x||'').trim()).filter(Boolean);
  const marks=Math.max(1,Number(q.marks)||1);
  if(!pts.length)return [];
  const n=Math.min(pts.length,marks);
  const use=pts.slice(0,n);
  const base=Math.floor(marks/n),extra=marks-base*n;
  return use.map((p,i)=>({point:p,marks:base+(i<extra?1:0)}));
}

function paperQuestionsHtml(normalized,passage,lang,withAnswers,mathMode){
       const fmt=v=>mathMode?mathHtml(esc(v)):esc(v);
       let lastSection='';
       const passageHtml=passage?`<div class="passage-block"><div class="passage-head">${esc(examText(lang,'passageLabel'))}</div>${passage.title?`<p class="passage-title">${esc(passage.title)}</p>`:''}<div class="passage-body">${String(passage.text).split(/\n+/).filter(x=>x.trim()).map(x=>`<p>${esc(x)}</p>`).join('')}</div></div>`:'';
       const numbers=[];let nn=0;const firstMatch=normalized.find(x=>x.type==='Matching');
       normalized.forEach((x,ix)=>{numbers[ix]=(x.type==='Matching'&&x!==firstMatch)?0:++nn;});
       return passageHtml+normalized.map((q,i)=>{
         const section=q.section||examText(lang,'questionsDefault');
         const isFill=/fill/i.test(q.type||'');
         let sectionHtml='';
         if(section!==lastSection){sectionHtml=`<h3 class="paper-section">${esc(section)}</h3>`;lastSection=section;}
         // Teacher-only: the learning objective each question measures appears in the answer key, never on the student paper.
         const objectiveHtml=(withAnswers&&q.objective)?`<div class="answer-box objective-box"><strong>${examText(lang,'objectiveLabel')}:</strong> ${esc(q.objective)}</div>`:'';
         if(q.type==='Matching'){
           // All matching questions are merged into ONE table with ONE heading; items continue below each other.
           const group=normalized.filter(x=>x.type==='Matching');
           if(group[0]!==q)return '';
           const pairs=[],choices=[];
           group.forEach(g=>{
             (Array.isArray(g.options)?g.options:[]).forEach(c=>{const t=String(c).replace(/^[A-Z][\.\):]\s*/i,'').trim();if(t&&!choices.includes(t))choices.push(t);});
             (Array.isArray(g.matches)?g.matches:[]).forEach(m=>pairs.push(m));
           });
           const letterOf=ans=>{const t=String(ans||'').replace(/^[A-Z][\.\):]\s*/i,'').trim();const k=choices.indexOf(t);return k>=0?String.fromCharCode(65+k):'';};
           const rows=pairs.map((pair,j)=>{
             const answerCell=withAnswers?esc(letterOf(pair.answer)||String(pair.answer||'')):'[       ]';
             const choiceCell=j===0?`<td rowspan="${Math.max(1,pairs.length)}" class="matching-choice-cell"><div class="matching-options">${choices.map((c,k)=>`<div><b>${String.fromCharCode(65+k)}.</b> ${fmt(c)}</div>`).join('')}</div></td>`:'';
             return `<tr><td class="match-no">${j+1}</td><td>${fmt(pair.question||'')}</td><td class="match-answer">${answerCell}</td>${choiceCell}</tr>`;
           }).join('');
           const groupMarks=group.reduce((sum,g)=>sum+(Number(g.marks)||0),0);
           const heading=group.length>1?examText(lang,'matchPrompt'):(q.text||examText(lang,'matchPrompt'));
           const correct=withAnswers?`<p class="matching-key"><strong>${examText(lang,'matchingKey')}:</strong> ${pairs.map((pr,j)=>`${j+1}-${esc(letterOf(pr.answer)||pr.answer||'')}`).join('; ')}</p>`:'';
           const objs=[...new Set(group.map(g=>g.objective).filter(Boolean))];
           const mObj=(withAnswers&&objs.length)?`<div class="answer-box objective-box"><strong>${examText(lang,'objectiveLabel')}:</strong> ${objs.map(esc).join('; ')}</div>`:'';
           const warning=choices.length>=pairs.length+group.length?'':(withAnswers?`<p class="muted"><em>${lang==='ar'?'تنبيه: يجب أن يزيد عدد الخيارات عن عدد العناصر.':lang==='so'?'Hubi: doorashooyinku waa inay ka badan yihiin tirada erayada.':'Check: provide more options than matching items.'}</em></p>`:'');
           return `${sectionHtml}<div class="paper-question matching-question"><p class="question-line"><strong>${numbers[i]}. ${esc(heading)}</strong><span class="marks">(${groupMarks} ${examText(lang,'marks')})</span></p><div class="table-wrap"><table class="matching-table"><thead><tr><th>${examText(lang,'number')}</th><th>${examText(lang,'columnA')}</th><th>${examText(lang,'answerLetter')}</th><th>${examText(lang,'columnB')}</th></tr></thead><tbody>${rows}</tbody></table></div>${correct}${mObj}${warning}</div>`;
         }
         const isMcqQ=/^(mcq|multiple choice)/i.test(q.type||'');
         if(withAnswers&&(isMcqQ||isFill)){
           const same=x=>(isMcqQ?/^(mcq|multiple choice)/i.test(x.type||''):/fill/i.test(x.type||''))&&x.section===q.section;
           const group=normalized.filter(same);
           if(group[0]!==q)return '';
           const items=group.map(g=>{
             const no=numbers[normalized.indexOf(g)];
             if(isMcqQ){const L=mcqLetter(g);return {no,val:L?`<b>${L}</b>`:fmt(g.answer||'—')};}
             return {no,val:esc(g.answer||'—')};
           });
           const gm=group.reduce((s,g)=>s+(Number(g.marks)||0),0);
           const lab={en:'Correct answers',so:'Jawaabaha saxda ah',ar:'الإجابات الصحيحة'}[lang]||'';
           return `${sectionHtml}<div class="paper-question key-block"><p class="key-label"><strong>${lab}</strong> <span class="marks">(${gm} ${examText(lang,'marks')})</span></p>${keyGridHtml(items,isMcqQ?5:3)}</div>`;
         }
         const options=q.options?.length?`<table class="mcq-options-table"><tbody><tr>${q.options.slice(0,4).map((opt,k)=>`<td><strong>${String.fromCharCode(65+k)}.</strong> ${fmt(String(opt).replace(/^[A-D][\.\):]\s*/i,''))}</td>`).join('')}</tr></tbody></table>`:'';
         const safeSvg=q.diagramSvg?sanitizeDiagramSvg(q.diagramSvg):'';
         const diagram=safeSvg?`<div class="exam-diagram">${safeSvg}</div>`:(q.diagram&&q.diagram!=='undefined'?`<div class="diagram-note"><strong>${lang==='ar'?'الرسم التوضيحي':lang==='so'?'Jaantus / sawir':'Diagram'}:</strong> ${esc(q.diagram)}</div>`:'');
         const isDirect=/structured|direct/i.test(q.type||'')||/STRUCTURED|DIRECT/i.test(section);
         const answerSpace=(!withAnswers&&isDirect)?`<div class="student-answer-label">${examText(lang,'studentAnswer')}:</div><div class="answer-space">${Array.from({length:Math.max(2,Math.min(14,Math.ceil(Number(q.marks||1)*1.4)))},()=>'<div class="answer-line"></div>').join('')}</div>`:'';
         const answer = withAnswers ? `<div class="answer-box"><strong>${examText(lang,'markingGuide')}:</strong> ${isFill?esc(q.answer||examText(lang,'notProvided')):fmt(q.answer||examText(lang,'notProvided'))}</div>` : '';
         const questionLine=`<div class="mcq-question-row"><span class="question-number">${numbers[i]}.</span><span class="question-text">${isFill?fillBlankHtml(q.text,q.answer,withAnswers):fmt(q.text)}</span><span class="marks">(${q.marks} ${examText(lang,'marks')})</span></div>`;
         if(q.type==='MCQ'||q.type==='Multiple Choice'||q.type==='Multiple Choice Questions'){
           return `${sectionHtml}<div class="paper-question mcq-box">${questionLine}${options}${answer}${objectiveHtml}</div>`;
         }
         if(isFill){
           const group=normalized.filter(x=>/fill/i.test(x.type||''));
           let boxHtml='';
           if(group[0]===q){
             const words=fillWordBox(group,lang);
             const instr={en:'Fill in the blank with the correct word from the word bank.',so:'Ku buuxi meesha banaan erayga saxda ah ee ku jira sanduuqa erayada.',ar:'اختر الكلمة المناسبة من الصندوق واكتبها في الفراغ.'}[lang]||'';
             boxHtml=`<p class="fill-instruction">${esc(instr)}</p><div class="word-box">${words.map(w=>`<span>${esc(w)}</span>`).join('')}</div>`;
           }
           return `${sectionHtml}${boxHtml}<div class="paper-question fill-question">${questionLine}${answer}${objectiveHtml}</div>`;
         }
         let keyPointsHtml='';
         if(withAnswers){
           const kp=allocKeyPoints(q);
           if(kp.length){
             const L={en:{h:'Key points for marking',m:'Marks',note:'Award the mark when the student expresses the idea in any correct wording.'},so:{h:'Qodobbada muhiimka ah ee sixidda',m:'Dhibcaha',note:'Dhibcaha waa la siiyaa haddii ardaygu fikradda ku qoro erayo kale oo sax ah.'},ar:{h:'النقاط الأساسية للتصحيح',m:'الدرجات',note:'تُمنح الدرجة إذا عبّر الطالب عن الفكرة بأي صياغة صحيحة.'}}[lang]||{h:'',m:'',note:''};
             keyPointsHtml=`<div class="key-points"><div class="kp-head"><strong>${L.h}</strong></div><table class="kp-table"><tbody>${kp.map((k,j)=>`<tr><td class="kp-n">${j+1}</td><td>${fmt(k.point)}</td><td class="kp-m">${k.marks} ${L.m}</td></tr>`).join('')}</tbody></table><div class="kp-note">${L.note}</div></div>`;
           }
         }
         return `${sectionHtml}<div class="paper-question structured-box">${questionLine}${diagram}${answerSpace}${answer}${keyPointsHtml}${objectiveHtml}</div>`;
       }).join('');
     }

let lastGenerated=null;
function buildPrintRoot(pkg){
  const {lang,examTitle,subject,className,normalized,passage}=pkg;
  const schoolName=schoolNameFor(lang);
  const instructions=String(pkg.instructions||'').trim()||examText(lang,'allQuestions');
  wordExamTitle=examTitle||'Exam';
  const total=normalized.reduce((sum,q)=>sum+(Number(q.marks)||0),0);
  const header=`<div class="paper-head" ${lang==='ar'?'dir="rtl" lang="ar"':''}><img class="exam-logo" src="/letterhead.jpg" alt="GHDD logo"><h1>${esc(schoolName)}</h1><h2>${esc(examTitle)}</h2><p>${esc(subject)} · ${esc(className)}</p></div>`;
  const meta=`<div class="paper-meta"><div><strong>${examText(lang,'name')}:</strong> ________________________</div><div><strong>${examText(lang,'date')}:</strong> ________________________</div><div><strong>${examText(lang,'class')}:</strong> ${esc(className)}</div><div><strong>${examText(lang,'total')}:</strong> ${total}</div></div>`;
  const examPaper=`<div class="student-paper-no-solutions" ${lang==='ar'?'dir="rtl" lang="ar"':''}>${header}${meta}<p><strong>${examText(lang,'instructions')}:</strong> ${esc(instructions)}${passage?' '+esc(examText(lang,'passageInstruction')):''}</p>${paperQuestionsHtml(normalized,passage,lang,false,isMathSubjectClient(subject))}<p><strong>${examText(lang,'total')}: ${total} ${examText(lang,'marks')}</strong></p></div>`;
  const answerPaper=`<div ${lang==='ar'?'dir="rtl" lang="ar"':''}>${header}<h2>${examText(lang,'answer')}</h2><p><strong>${examText(lang,'total')}:</strong> ${total} ${examText(lang,'marks')}</p>${paperQuestionsHtml(normalized,passage,lang,true,isMathSubjectClient(subject))}</div>`;
  $('printRoot').innerHTML=`<div class="paper-tools no-print"><button class="green word-dl" data-which="exam">📄 Word .docx — Imtixaanka</button><button class="green word-dl" data-which="key">📄 Word .docx — Answer key</button><button class="green word-dl" data-which="both">📄 Word .docx — Labadaba</button><button id="printExamOnly" class="secondary">Daabac imtixaanka (jawaabaha ma muuqdaan)</button><button id="printAnswerKey">Daabac answer key</button></div><div id="studentPaper">${examPaper}</div><div id="keyPaper" style="margin-top:35px;border-top:3px double #333;padding-top:18px">${answerPaper}</div>`;
  $('printExamOnly').onclick=()=>printSelection('exam');
  $('printAnswerKey').onclick=()=>printSelection('key');
  return total;
}
function printSelection(which){
  document.body.classList.add('print-mode');
  $('studentPaper').style.display=which==='key'?'none':'block';
  $('keyPaper').style.display=which==='exam'?'none':'block';
  if(which==='both'){$('keyPaper').style.display='block';}
  window.print();
  setTimeout(()=>document.body.classList.remove('print-mode'),700);
}

async function saveExamPackage(){
  if(!questions.length)return alert('Ku dar su’aalo marka hore.');
  const meta=lastGenerated||{};
  const lang=meta.lang||currentExamLang();
  if(currentExamBlueprint&&Array.isArray(currentExamBlueprint.coverage))computeTos(currentExamBlueprint,questions);
  const exam={
    id:currentExamId||uid(),
    title:$('examName').value.trim()||'Imtixaan',
    subject:$('subject').value.trim(),
    className:$('className').value.trim(),
    instructions:$('examInstructions').value,
    language:lang,
    passage:meta.passage||null,
    questions:JSON.parse(JSON.stringify(questions)),
    blueprint:currentExamBlueprint||{},
    totalMarks:questions.reduce((sum,q)=>sum+(Number(q.marks)||0),0),
    createdAt:new Date().toISOString()
  };
  exams.unshift(exam);
  questionBank.push(...exam.questions.map(q=>({...q,subject:exam.subject,className:exam.className})));
  try{localStorage.setItem('ghdd_exams',JSON.stringify(exams));localStorage.setItem('ghdd_bank',JSON.stringify(questionBank));}catch(e){console.warn('Local storage full:',e.message);}
  renderBank();
  try{
    const saved=await api('/api/assessments',{method:'POST',body:JSON.stringify({title:exam.title,subject:exam.subject,klass:exam.className,totalMarks:exam.totalMarks,school:'GHDD',blueprint:exam.blueprint,data:{kind:'exam',language:lang,passage:exam.passage,instructions:exam.instructions,questions:exam.questions}})});
    exam.databaseId=saved.id;
    try{localStorage.setItem('ghdd_exams',JSON.stringify(exams));}catch(_){}
    alert('Imtixaanka (iyo Blueprint-ka) waa la keydiyay. Waxaad ka heli doontaa tabka 🗂️ Dashboard.');
  }catch(e){
    alert('Imtixaanka waxaa lagu keydiyay browser-ka, laakiin database-ka lama keydin: '+e.message+'\nHubi furaha maamulka iyo Railway database-ka.');
  }
}

// ---------------- Dashboard: saved exams + saved blueprints ----------------
function fmtBytes(n){n=Number(n)||0;if(n>=1073741824)return (n/1073741824).toFixed(2)+' GB';if(n>=1048576)return (n/1048576).toFixed(1)+' MB';if(n>=1024)return Math.round(n/1024)+' KB';return n+' B';}
async function loadStorage(){
  const el=$('dashStorage');if(!el)return;
  el.innerHTML='<div class="item muted">Waa la soo rarayaa...</div>';
  let st;
  try{st=await api('/api/storage');}catch(e){el.innerHTML=`<div class="item muted">⚠️ Macluumaadka kaydka lama helin: ${esc(e.message)}</div>`;return;}
  const top=info=>(info.tables||[]).slice(0,4).map(t=>`${esc(t.name)}: ${fmtBytes(t.bytes)}`).join(' · ');
  let h=`<div class="item"><b>🗄️ Database-ka imtixaannada</b><p class="muted">Wadarta: <b>${fmtBytes(st.main.bytes)}</b> · ${top(st.main)}</p>`;
  if(st.split){
    h+=`<b>📚 Database-ka buugaagta (OCR)</b><p class="muted">Wadarta: <b>${fmtBytes(st.books.bytes)}</b> · ${top(st.books)}</p><p class="muted">✅ Buugaagta iyo imtixaannadu waa kala gooni: AI-gu wuxuu qoraalka ka qaadaa database-ka buugaagta, imtixaannada oo keliya ayaa lagu keydiyaa kan kale.</p>`;
  }else{
    h+=`<p class="muted">Buugaagta iyo imtixaannadu waxay ku jiraan isla database-ka. Si aad u kala saarto: Railway → project-kaaga → <b>+ New → Database → PostgreSQL</b>, kadibna service-ka <b>ghdd-assessment-pro → Variables</b> ku dar <code>BOOKS_DATABASE_URL</code> = <code>\${{Postgres-XXXX.DATABASE_URL}}</code> (magaca Postgres-ka cusub). Kadib re-deploy.</p>`;
  }
  h+=`<div class="paper-tools no-print">`;
  if(st.split&&st.legacyBooks>0)h+=`<button id="stMigrate" class="green">📦 U wareeji ${st.legacyBooks} buug database-ka buugaagta (PDF-yada waa la ka tirayaa)</button>`;
  h+=`<button id="stPurge" class="danger">🗑️ Ka tir PDF-yada oo dhan (qoraalka ilaali)</button><button id="stRefresh" class="secondary">↻ Cusboonaysii</button></div></div>`;
  h+=(st.bookList||[]).map(b=>`<div class="item"><b>${esc(b.title||'—')}</b><p class="muted">${Number(b.pageCount)||0} bog · qoraal: ${Number(b.textChars)||0} xaraf · PDF: <b>${fmtBytes(b.pdfBytes)}</b></p>${Number(b.pdfBytes)>0?`<div class="paper-tools no-print"><button class="danger" data-st-pdf="${esc(b.id)}">Ka tir PDF-ka kaliya</button></div>`:'<p class="muted">PDF-ga waa la tirtiray; qoraalka ayaa la hayaa.</p>'}</div>`).join('');
  el.innerHTML=h;
  $('stRefresh').onclick=loadStorage;
  $('stPurge').onclick=async()=>{
    if(!confirm('Ma tirtirtaa PDF-yada buugaagta oo dhan?\n\nQoraalka OCR, imtixaannada iyo Blueprint-yada waa hadhayaan. Kaliya PDF-yada asalka ah ayaa lumaya (ma awoodid inaad dib u soo dejiso PDF-ka).'))return;
    try{const r=await api('/api/storage/purge-pdfs',{method:'POST',body:JSON.stringify({confirm:true})});alert('PDF-yada waa la tirtiray.\nHore: '+fmtBytes(r.beforeBytes)+' → Hadda: '+fmtBytes(r.afterBytes)+(r.compacted?'':'\n(Meesha si buuxda looma siidaynin; haddii Railway weli muujiyo buuxsan, mar kale isku day.)'));}
    catch(e){alert('Khalad: '+e.message);}
    loadStorage();
  };
  const mg=$('stMigrate');
  if(mg)mg.onclick=async()=>{
    if(!confirm('Ma u wareejisaa buugaagta database-ka buugaagta?\n\nWaxaa la koobiyeynayaa qoraalka OCR kaliya. Kadib database-ka hore waxaa laga tirtirayaa buugaagta iyo PDF-yadooda (si meel looga bixiyo).'))return;
    mg.disabled=true;mg.textContent='Waa la wareejinayaa...';
    try{const r=await api('/api/storage/migrate-books',{method:'POST',body:JSON.stringify({confirm:true,deleteOld:true})});alert('Wareejinta: '+(r.migrated||0)+' buug la wareejiyay'+(r.skipped?', '+r.skipped+' hore u jiray':'')+(r.failed?', '+r.failed+' fashilmay (database-ka hore lama tirtirin)':'')+(r.oldCleared?'. Database-ka hore waa la nadiifiyay.':'.'));}
    catch(e){alert('Khalad: '+e.message);}
    loadStorage();
  };
  el.querySelectorAll('[data-st-pdf]').forEach(btn=>btn.onclick=async()=>{
    if(!confirm('Ma tirtirtaa PDF-ka buuggan? Qoraalka OCR waa hadhayaa.'))return;
    try{await api('/api/books/'+encodeURIComponent(btn.dataset.stPdf)+'/pdf',{method:'DELETE'});}catch(e){alert('Khalad: '+e.message);}
    loadStorage();
  });
}
function fmtDate(x){try{return new Date(x).toLocaleString();}catch(_){return '';}}
async function loadDashboard(){
  const elE=$('dashExams'),elB=$('dashBlueprints');
  if(!elE||!elB)return;
  elE.innerHTML=elB.innerHTML='<div class="item muted">Waa la soo rarayaa...</div>';
  let rows=[],dbError='';
  try{const r=await api('/api/assessments');rows=Array.isArray(r)?r:[];}catch(e){dbError=e.message;}
  const dbIds=new Set(rows.map(r=>r.id));
  const dbExams=rows.filter(r=>(r.kind||'exam')!=='blueprint').map(r=>({src:'db',id:r.id,title:r.title,subject:r.subject,className:r.klass,marks:r.total_marks,count:r.question_count,date:r.created_at}));
  const dbBps=rows.filter(r=>r.kind==='blueprint').map(r=>({src:'db',id:r.id,title:r.title,subject:r.subject,className:r.klass,marks:r.total_marks,date:r.created_at}));
  const locExams=exams.filter(x=>!x.databaseId||!dbIds.has(x.databaseId)).map(x=>({src:'local',id:x.id,title:x.title,subject:x.subject,className:x.className,marks:x.totalMarks,count:(x.questions||[]).length,date:x.createdAt}));
  const locBps=loadSavedBlueprints().filter(x=>!x.databaseId||!dbIds.has(x.databaseId)).map(x=>({src:'local',id:x.id,title:x.title,subject:x.subject,className:x.className,marks:x.blueprint?.totalMarks,date:x.savedAt}));
  const card=(x,kind)=>`<div class="item"><b>${esc(x.title||'—')}</b><p class="muted">${esc(x.subject||'')}${x.className?' · '+esc(x.className):''} · ${esc(fmtDate(x.date))}</p><p class="muted">${Number(x.marks)||0} dhibcood${kind==='exam'?' · '+(Number(x.count)||0)+' su’aalood':''} · ${x.src==='db'?'🗄️ Database':'📱 Browser kaliya'}</p><div class="paper-tools no-print"><button class="secondary" data-dash-open="${kind}|${x.src}|${esc(x.id)}">Fur</button>${kind==='exam'?`<button class="secondary" data-dash-print="exam|${x.src}|${esc(x.id)}">🖨️ Imtixaan</button><button class="secondary" data-dash-print="key|${x.src}|${esc(x.id)}">🔑 Answer key</button>`:`<button class="secondary" data-dash-print="bp|${x.src}|${esc(x.id)}">🖨️ Daabac</button>`}<button class="danger" data-dash-del="${kind}|${x.src}|${esc(x.id)}">Tir</button></div></div>`;
  const listE=[...dbExams,...locExams],listB=[...dbBps,...locBps];
  elE.innerHTML=(dbError?`<div class="item muted">⚠️ Database-ka lama soo dejin: ${esc(dbError)} (waxaa la muujinayaa kaydka browser-ka).</div>`:'')+(listE.length?listE.map(x=>card(x,'exam')).join(''):'<div class="item muted">Weli imtixaan lama keydin. Samee imtixaan, kadibna riix “💾 Keydi imtixaanka”.</div>');
  elB.innerHTML=listB.length?listB.map(x=>card(x,'bp')).join(''):'<div class="item muted">Weli Blueprint lama keydin. Samee Blueprint, kadibna riix “💾 Keydi Blueprint”.</div>';
  loadStorage();
  document.querySelectorAll('[data-dash-open]').forEach(b=>b.onclick=()=>dashOpen(...b.dataset.dashOpen.split('|')));
  document.querySelectorAll('[data-dash-print]').forEach(b=>b.onclick=()=>dashPrint(...b.dataset.dashPrint.split('|')));
  document.querySelectorAll('[data-dash-del]').forEach(b=>b.onclick=()=>dashDelete(...b.dataset.dashDel.split('|')));
}
async function fetchSavedPackage(kind,src,id){
  if(src==='local'){
    if(kind==='bp'){const x=loadSavedBlueprints().find(y=>y.id===id);return x&&{title:x.title,subject:x.subject,className:x.className,language:x.lang||'so',blueprint:x.blueprint};}
    const x=exams.find(y=>y.id===id);
    return x&&{id:x.id,title:x.title,subject:x.subject,className:x.className,instructions:x.instructions,language:x.language||detectExamLanguage((x.questions||[]).map(q=>q.text).join(' ')),passage:x.passage||null,questions:x.questions||[],blueprint:x.blueprint||{},totalMarks:x.totalMarks};
  }
  const r=await api('/api/assessments/'+encodeURIComponent(id));
  const d=r.data||{};
  const qs=d.questions||[];
  return {id:r.id,title:r.title,subject:r.subject,className:r.klass,instructions:d.instructions||'',language:d.language||(qs.length?detectExamLanguage(qs.map(q=>q.text).join(' ')):'so'),passage:d.passage||null,questions:qs,blueprint:r.blueprint||{},totalMarks:r.total_marks};
}
async function dashOpen(kind,src,id){
  const viewer=$('dashViewer');
  viewer.innerHTML='<div class="item muted">Waa la furayaa...</div>';
  try{
    const pkg=await fetchSavedPackage(kind,src,id);
    if(!pkg)throw new Error('Lama helin.');
    const lang=['en','so','ar'].includes(pkg.language)?pkg.language:'so';
    if(kind==='bp'){
      currentExamBlueprint=pkg.blueprint;
      viewer.innerHTML=`<div class="panel"><h3>${esc(pkg.title)}</h3>${blueprintTableHtml(pkg.blueprint,lang)}<div class="paper-tools no-print"><button id="dashPrintBp">🖨️ Daabac Blueprint</button></div></div>`;
      $('dashPrintBp').onclick=()=>printBlueprintDoc(pkg.blueprint,lang);
    }else{
      questions=pkg.questions;
      $('examName').value=pkg.title||'';$('subject').value=pkg.subject||'';$('className').value=pkg.className||'';$('examInstructions').value=pkg.instructions||'';
      const sel=$('examLanguage');if(sel)sel.value=lang;
      currentExamBlueprint=(pkg.blueprint&&Object.keys(pkg.blueprint).length)?pkg.blueprint:null;
      currentExamId=null;lastGenerated={lang,passage:pkg.passage};
      renderQuestions();
      const total=buildPrintRoot({lang,examTitle:pkg.title||'',subject:pkg.subject||'',className:pkg.className||'',normalized:pkg.questions,passage:pkg.passage,instructions:pkg.instructions||''});
      viewer.innerHTML=`<div class="panel"><h3>${esc(pkg.title)}</h3><p class="muted">${esc(pkg.subject||'')} · ${esc(pkg.className||'')} · ${total} dhibcood · ${pkg.questions.length} su’aalood</p><div class="paper-tools no-print"><button id="dashPrintExam">🖨️ Daabac imtixaanka</button><button id="dashPrintKey" class="secondary">🔑 Daabac answer key</button><button id="dashPrintBoth" class="secondary">Daabac labadaba</button><button id="dashEdit" class="secondary">✏️ Ku fur Imtixaanka (tafatir)</button><button class="secondary word-dl" data-which="exam">📄 Soo deji Word .docx (imtixaanka)</button><button class="secondary word-dl" data-which="key">📄 Word .docx (answer key)</button></div>${pkg.passage?`<div class="passage-block" ${lang==='ar'?'dir="rtl"':''}><div class="passage-head">${esc(examText(lang,'passageLabel'))}</div>${pkg.passage.title?`<p class="passage-title">${esc(pkg.passage.title)}</p>`:''}<div class="passage-body">${String(pkg.passage.text).split(/\n+/).filter(x=>x.trim()).map(x=>`<p>${esc(x)}</p>`).join('')}</div></div>`:''}<div class="list">${questionCardsHtml(lang,false)}</div>${(pkg.blueprint&&pkg.blueprint.coverage)?`<details class="item"><summary>📐 Blueprint + TOS</summary>${blueprintTableHtml(pkg.blueprint,lang)}<div class="paper-tools no-print"><button id="dashPrintBp2" class="secondary">🖨️ Daabac Blueprint + TOS</button></div></details>`:''}</div>`;
      if($('dashPrintBp2'))$('dashPrintBp2').onclick=()=>printBlueprintDoc(pkg.blueprint,lang);
      $('dashPrintExam').onclick=()=>printSelection('exam');
      $('dashPrintKey').onclick=()=>printSelection('key');
      $('dashPrintBoth').onclick=()=>printSelection('both');
      $('dashEdit').onclick=()=>showTab('builder');
    }
    viewer.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){viewer.innerHTML=`<div class="item muted">Khalad: ${esc(e.message)}</div>`;}
}
async function dashPrint(what,src,id){
  try{
    const kind=what==='bp'?'bp':'exam';
    const pkg=await fetchSavedPackage(kind,src,id);
    if(!pkg)throw new Error('Lama helin.');
    const lang=['en','so','ar'].includes(pkg.language)?pkg.language:'so';
    if(kind==='bp'){printBlueprintDoc(pkg.blueprint,lang);return;}
    lastGenerated={lang,passage:pkg.passage};
    buildPrintRoot({lang,examTitle:pkg.title||'',subject:pkg.subject||'',className:pkg.className||'',normalized:pkg.questions,passage:pkg.passage,instructions:pkg.instructions||''});
    printSelection(what==='key'?'key':'exam');
  }catch(e){alert('Daabacaadda: '+e.message);}
}
async function dashDelete(kind,src,id){
  if(!confirm('Ma tirtirtaa kaydkan?'))return;
  try{
    if(src==='db')await api('/api/assessments/'+encodeURIComponent(id),{method:'DELETE'});
    else if(kind==='bp')localStorage.setItem(BP_STORE,JSON.stringify(loadSavedBlueprints().filter(x=>x.id!==id)));
    else{exams=exams.filter(x=>x.id!==id);localStorage.setItem('ghdd_exams',JSON.stringify(exams));}
    // also drop the browser copy that points to this database record
    if(src==='db'){exams=exams.filter(x=>x.databaseId!==id);localStorage.setItem('ghdd_exams',JSON.stringify(exams));localStorage.setItem(BP_STORE,JSON.stringify(loadSavedBlueprints().filter(x=>x.databaseId!==id)));renderSavedBlueprints();}
    $('dashViewer').innerHTML='';
    loadDashboard();
  }catch(e){alert('Lama tirtirin: '+e.message);}
}
function questionCardsHtml(lg,removable){
  // Bloom badge is for the teacher on screen only (.bloom-preview is hidden when printing; the student paper never contains it).
  const copyLabel={en:'Student copy to be printed',so:'Nuqulka ardayga ee la daabacayo',ar:'نسخة الطالب المطبوعة'}[lg];
  const qWord={en:'Question',so:'Su’aasha',ar:'السؤال'}[lg];
  const markWord=m=>lg==='en'?(m===1?'mark':'marks'):examText(lg,'marks');
  return questions.map((q,i)=>`
    <div class="item">
      <div class="q-card-head"><b>${qWord} ${i+1}</b><span class="bloom-badge bloom-preview">${esc(bloomName(lg,q.level||q.bloom||'Understand'))}</span></div>
      <p>${esc(noBloom(q.text))}</p>
      ${q.objective?`<p class="muted"><b>${examText(lg,'objectiveLabel')}:</b> ${esc(q.objective)}</p>`:''}
      <p><b>${examText(lg,'studentAnswer')}:</b> ${esc(q.answer||'')}</p>
      <div class="student-copy-preview"><small>${copyLabel}</small><b>${i+1}.</b> ${esc(noBloom(q.text))} (${Number(q.marks)||1} ${markWord(Number(q.marks)||1)})</div>
      ${removable?`<button class="danger" data-remove-q="${q.id}">Ka saar</button>`:''}
    </div>`).join('');
}
function renderQuestions(){
  const el=$('questionList');
  const lg=currentExamLang();
  if(!questions.length){
    el.innerHTML='<div class="item muted">Weli su’aalo lama darin.</div>';
    return;
  }
  el.innerHTML=questionCardsHtml(lg,true);

  el.querySelectorAll('[data-remove-q]').forEach(btn=>{
    btn.onclick=()=>{
      questions=questions.filter(q=>q.id!==btn.dataset.removeQ);
      renderQuestions();
    };
  });
}
$('addQuestion').onclick=()=>{
  const text=$('qText').value.trim();
  if(!text)return alert('Qor su’aasha marka hore.');
  questions.push({
    id:uid(),text,
    marks:Number($('qMarks').value)||1,
    level:$('qLevel').value,
    answer:$('qAnswer').value.trim()
  });
  $('qText').value='';
  $('qAnswer').value='';
  renderQuestions();
};
$('printExam').onclick=()=>window.print();
renderSavedBlueprints();
$('refreshDash').onclick=loadDashboard;

$('saveExam').onclick=saveExamPackage;

function renderBank(){
  const el=$('bankList');
  if(!questionBank.length){
    el.innerHTML='<div class="item muted">Weli su’aalo lama kaydin.</div>';
    return;
  }
  el.innerHTML=questionBank.map((q,i)=>`
    <div class="item">
      <b>${i+1}. ${esc(q.text)}</b>
      <p class="muted">${esc(q.subject||'')} · ${esc(q.className||'')}</p>
      <p><b>Jawaab:</b> ${esc(q.answer||'')}</p>
    </div>`).join('');
}
$('runAnalysis').onclick=()=>{
  const el=$('analysisResult');
  if(!questions.length){
    el.innerHTML='<div class="item">Ku dar su’aalo si loo falanqeeyo.</div>';
    return;
  }
  const total=questions.reduce((s,q)=>s+(Number(q.marks)||0),0);
  const missing=questions.filter(q=>!q.answer).length;
  const levels={};
  questions.forEach(q=>levels[q.level]=(levels[q.level]||0)+1);
  el.innerHTML=`
    <div class="item">Tirada su’aalaha: <b>${questions.length}</b></div>
    <div class="item">Wadarta dhibcaha: <b>${total}</b></div>
    <div class="item">Su’aalaha aan jawaab lahayn: <b>${missing}</b></div>
    <div class="item">Heerarka Bloom: ${Object.entries(levels).map(([k,v])=>`${esc(k)}: ${v}`).join(' · ')}</div>`;
};
$('downloadBackup').onclick=()=>{
  const blob=new Blob([JSON.stringify({questions,questionBank,exams},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='GHDD_Assessment_Backup.json';a.click();
  URL.revokeObjectURL(url);
};


// Lesson Plan + Lesson Note: Scheme of Work controls sequence; OCR textbook supplies lesson content.
let generatedLessonPackage = null;
const lpEsc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const lpEl = id => document.getElementById(id);
let lessonBooks = [];

async function loadLessonBookOptions() {
  const select=lpEl('lpTextbookBook');
  if(!select) return;
  select.innerHTML='<option value="">Buugaagta waa la soo rarayaa...</option>';
  try {
    const d=await api('/api/books',{method:'GET'});
    lessonBooks=d.books||[];
    select.innerHTML='<option value="">Dooro buugga maaddada OCR...</option>'+lessonBooks.map(b=>
      `<option value="${lpEsc(b.id)}" data-pages="${Number(b.page_count)||1}" data-subject="${lpEsc(b.subject||'')}">${lpEsc(b.title)} — ${Number(b.page_count)||'?'} bog — ${Number(b.text_chars||0).toLocaleString()} xaraf OCR</option>`
    ).join('');
    if(!lessonBooks.length) lpEl('schemeFileStatus').textContent='Database-ka kuma jiro buug OCR ah. Marka hore buugga maaddada ku kaydi tab-ka Buugaagta PDF/OCR.';
    select.onchange=()=>{
      const option=select.selectedOptions[0], pages=Number(option?.dataset.pages)||1;
      lpEl('lpTextbookStart').max=pages;lpEl('lpTextbookEnd').max=pages;lpEl('lpTextbookEnd').value=pages;
      if(!lpEl('lpSubject').value.trim() && option?.dataset.subject) lpEl('lpSubject').value=option.dataset.subject;
    };
  } catch(e) {
    select.innerHTML='<option value="">Buugaagta lama soo dejin</option>';
    lpEl('schemeFileStatus').textContent='Khalad: '+e.message;
  }
}
lpEl('refreshLessonBooks').onclick=loadLessonBookOptions;

// Scheme of Work PDF is read from its embedded text layer only. No OCR and no database upload.
lpEl('loadSchemePdf').onclick=async()=>{
  const file=lpEl('lpSchemePdf').files[0];
  const status=lpEl('schemePdfStatus');
  const btn=lpEl('loadSchemePdf');
  if(!file) return alert('Fadlan dooro Scheme of Work PDF marka hore.');
  if(file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf')) return alert('Fadlan dooro fayl PDF ah.');
  if(!window.pdfjsLib) return alert('PDF.js lama helin. Hubi internetka.');
  btn.disabled=true;status.textContent='PDF-ga ayaa la akhrinayaa (text layer oo keliya; OCR ma jiro)...';
  try{
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const data=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data}).promise;
    if(pdf.numPages>1000) throw new Error('Scheme of Work wuxuu ka badan yahay 1000 bog; fadlan isticmaal PDF-ga Scheme of Work oo keliya.');
    const pages=[];let totalChars=0;
    for(let n=1;n<=pdf.numPages;n++){
      const page=await pdf.getPage(n);
      const content=await page.getTextContent();
      const text=content.items.map(item=>item.str||'').join(' ').replace(/\s+/g,' ').trim();
      if(text) {pages.push(`[Page ${n}]\n${text}`);totalChars+=text.length;}
      status.textContent=`Akhrinta qoraalka PDF: bogga ${n}/${pdf.numPages}...`;
    }
    if(totalChars<80) throw new Error('PDF-ga ma laha qoraal la akhrin karo. Waxaa laga yaabaa inuu yahay scan/sawir. Ma samaynayno OCR; fadlan dooro PDF qoraalkiisu la dooran karo yahay.');
    lpEl('schemeText').value=`SCHEME OF WORK PDF: ${file.name}\nTOTAL PAGES: ${pdf.numPages}\n\n${pages.join('\n\n')}`;
    status.textContent=`Waa la akhriyey: ${file.name} — ${pdf.numPages} bog, ${totalChars.toLocaleString()} xaraf. OCR lama samayn, buuggana database-ka OCR laguma darin.`;
  }catch(e){status.textContent='Khalad: '+e.message;alert('Scheme of Work PDF: '+e.message);}
  finally{btn.disabled=false;}
};

async function loadSavedOCRText(kind) {
  const selectId='lpTextbookBook';
  const startId='lpTextbookStart';
  const endId='lpTextbookEnd';
  const targetId='textbookText';
  const buttonId='loadTextbookOCR';
  const id=lpEl(selectId).value;
  if(!id) return alert('Fadlan ka dooro buugga maaddada OCR ee database-ka.');
  const start=Math.max(1,Number(lpEl(startId).value)||1);
  const end=Math.max(start,Number(lpEl(endId).value)||start);
  const book=lessonBooks.find(b=>String(b.id)===String(id));
  const maxPages=Number(book?.page_count)||end;
  if(start>maxPages||end>maxPages) return alert(`Bogagga buuggan waxay u dhexeeyaan 1 iyo ${maxPages}.`);
  const status=lpEl('schemeFileStatus'), btn=lpEl(buttonId);
  btn.disabled=true;status.textContent='Qoraalka buugga maaddada ee OCR database-ka ayaa la soo qaadanayaa...';
  try{
    const data=await api(`/api/books/${encodeURIComponent(id)}/text?start=${start}&end=${end}`,{method:'GET'});
    const pages=Array.isArray(data.pages)?data.pages:[];
    const text=pages.map(p=>`[Page ${p.page}]\n${String(p.text||'').trim()}`).filter(x=>x.trim()).join('\n\n');
    if(text.trim().length<80) throw new Error('Bogagga la doortay qoraal OCR oo ku filan kuma jiraan. Hubi bogagga buugga database-ka.');
    lpEl(targetId).value=`BOOK: ${data.title||book?.title||''}\nPAGES: ${start}-${end}\n\n${text}`;
    status.textContent=`Buugga maaddada OCR waa la soo qaaday: ${pages.length} bog — ${data.title||book?.title||''}.`;
    if(!lpEl('lpSubject').value.trim() && book?.subject) lpEl('lpSubject').value=book.subject;
  }catch(e){status.textContent='Khalad: '+e.message;alert('Qoraalka OCR: '+e.message);}
  finally{btn.disabled=false;}
}
lpEl('loadTextbookOCR').onclick=()=>loadSavedOCRText('textbook');

function lpList(items) {
  return Array.isArray(items) && items.length ? `<ul>${items.map(x=>`<li>${lpEsc(x)}</li>`).join('')}</ul>` : '<p>—</p>';
}
function renderLessonPackage(pkg) {
  const output=lpEl('lessonPlanOutput');
  const lessons=pkg.lessons||[];
  let content=`<div class="notice"><b>Waxaa la sameeyey ${lessons.length} cashar.</b> Dib u eeg qorshaha iyo qoraallada casharrada. Hubi in mawduucyada ku jira bogagga OCR ee aad dooratay la daboolay.</div>
    <h2>${lpEsc(pkg.subject||'')} — ${lpEsc(pkg.className||'')}</h2>
    <p><b>Academic year:</b> ${lpEsc(pkg.academicYear||'')} &nbsp; <b>Teacher:</b> ${lpEsc(pkg.teacherName||'')}</p>
    <h3>Year overview</h3><p>${lpEsc(pkg.yearOverview||'')}</p>`;
  if(pkg.assumptions?.length) content+=`<h3>Assumptions / items to verify</h3>${lpList(pkg.assumptions)}`;
  content+=`<div class="lesson-plan-tools no-print"><button id="lpPrintAll">🖨️ Daabac dhammaan Lesson Plans + Notes</button><button class="secondary" id="lpDownloadJson">Soo dejiso backup (JSON)</button></div>`;
  lessons.forEach((l,i)=>{
    const tm=Array.isArray(l.timeManagement)?l.timeManagement:[];
    const total=tm.reduce((s,t)=>s+Number(t.minutes||0),0);
    content+=`<article class="lesson-plan-card">
      <h3>HOWLWADAAG SECONDARY SCHOOL</h3><h4>LESSON PLAN ${lpEsc(pkg.academicYear||'')}</h4>
      <table><tr><th>Teacher</th><td>${lpEsc(pkg.teacherName||'')}</td><th>Class</th><td>${lpEsc(pkg.className||'')}</td></tr>
      <tr><th>Subject</th><td>${lpEsc(pkg.subject||'')}</td><th>Date / Day</th><td>${lpEsc(l.date||'________________')}</td></tr>
      <tr><th>Term / Week</th><td>${lpEsc(l.term||'')} / ${lpEsc(l.week||'')}</td><th>Unit</th><td>${lpEsc(l.unit||'')}</td></tr>
      <tr><th>Lesson</th><td>${lpEsc(l.lessonTitle||'')}</td><th>Time / Session</th><td>${lpEsc(l.durationMinutes||40)} min / ${lpEsc(l.lessonNumber||i+1)}</td></tr></table>
      <div class="lp-section-title">Introduction</div><p>${lpEsc(l.introduction||'')}</p>
      <div class="lp-section-title">Lesson Objectives</div><p>By the end of the lesson, learners should be able to:</p>${lpList(l.objectives)}
      <div class="lp-section-title">Teaching Methods</div>${lpList(l.teachingMethods)}
      <div class="lp-section-title">Learning Aids</div>${lpList(l.learningAids)}
      <div class="lp-section-title">Evaluation</div>${lpList(l.evaluationQuestions)}
      <div class="lp-section-title">Time Management (${total} min)</div><table><thead><tr><th>Stage / Activity</th><th>Time (min)</th></tr></thead><tbody>${tm.map(t=>`<tr><td>${lpEsc(t.stage||'')}</td><td>${Number(t.minutes||0)}</td></tr>`).join('')}<tr><th>Total</th><th>${total}</th></tr></tbody></table>
      <div class="lp-section-title">LESSON NOTE — ${lpEsc(l.lessonTitle||'')}</div>
      <h4>Summary</h4><p>${lpEsc(l.noteSummary||'')}</p>
      ${(l.noteHeadings||[]).map(n=>`<h4 style="text-align:left">${lpEsc(n.heading||'')}</h4><p>${lpEsc(n.content||'')}</p>`).join('')}
      <h4 style="text-align:left">Homework</h4><p>${lpEsc(l.homework||'')}</p>
      <p><i>Scheme topic: ${lpEsc(l.sourceTopic||l.lessonTitle||'')}</i></p>
    </article>`;
  });
  output.innerHTML=content;
  output.classList.remove('hidden');
  lpEl('lpPrintAll').onclick=()=>{
    const oldTitle=document.title; document.title=`Lesson Plans ${pkg.subject||''} ${pkg.academicYear||''}`;
    document.body.classList.add('lesson-print-mode');
    const style=document.createElement('style');style.id='lessonPrintTemp';
    style.textContent='@media print{body.lesson-print-mode>header,body.lesson-print-mode>.wrap>nav,body.lesson-print-mode>footer,body.lesson-print-mode .no-print{display:none!important}body.lesson-print-mode .tab{display:none!important}body.lesson-print-mode #lessonplan{display:block!important}body.lesson-print-mode #lessonplan .panel:first-child,body.lesson-print-mode #lessonplan .panel:nth-child(2){display:none!important}body.lesson-print-mode #lessonPlanOutput{display:block!important;border:0!important;padding:0!important;margin:0!important}body.lesson-print-mode .lesson-plan-card{break-after:page;page-break-after:always}}';
    document.head.appendChild(style);window.print();
    setTimeout(()=>{document.body.classList.remove('lesson-print-mode');style.remove();document.title=oldTitle;},700);
  };
  lpEl('lpDownloadJson').onclick=()=>{
    const blob=new Blob([JSON.stringify(pkg,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');
    a.href=url;a.download=`Lesson_Plans_${(pkg.subject||'subject').replace(/[^a-z0-9_-]/gi,'_')}_${pkg.academicYear||'year'}.json`;a.click();URL.revokeObjectURL(url);
  };
}

lpEl('generateLessonYear').onclick=async()=>{
  const schemeText=lpEl('schemeText').value.trim();
  const textbookText=lpEl('textbookText').value.trim();
  if(schemeText.length<80) return alert('Marka hore dooro Scheme of Work PDF oo riix “Akhri Scheme of Work PDF”.');
  if(textbookText.length<80) return alert('Marka hore soo qaado qoraalka buugga maaddada OCR-ga.');
  const btn=lpEl('generateLessonYear');
  const status=lpEl('lpStatus');
  btn.disabled=true;status.textContent='AI-gu wuxuu qoraalka laga akhriyey Scheme of Work PDF uga raacayaa kala-horraynta sannadka; buugga maaddada wuxuu ka soo qaadanayaa OCR database-ka. Ha xirin bogga...';
  try {
    const response=await fetch('/api/lesson-plan/generate',{
      method:'POST',headers:{'Content-Type':'application/json',...headers()},
      body:JSON.stringify({
        schemeText,
        textbookText,
        subject:lpEl('lpSubject').value.trim(),
        className:lpEl('lpClass').value.trim(),
        teacherName:lpEl('lpTeacher').value.trim(),
        academicYear:lpEl('lpYear').value.trim()||'2026-2027',
        language:lpEl('lpLanguage').value,
        lessonDuration:Number(lpEl('lpDuration').value)||40,
        lessonsPerWeek:Number(lpEl('lpPerWeek').value)||3,
        termCount:Number(lpEl('lpTerms').value)||3
      })
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||`Server error ${response.status}`);
    generatedLessonPackage=data;renderLessonPackage(data);
    status.textContent=`Waa diyaar: ${data.lessons.length} cashar ayaa la sameeyey. Hubi natiijada, kadib daabac ama soo dejiso backup.`;
    lpEl('lessonPlanOutput').scrollIntoView({behavior:'smooth',block:'start'});
  } catch(e) {
    status.textContent='Khalad: '+e.message;
    alert('Lesson Plan + Lesson Note: '+e.message);
  } finally {btn.disabled=false;}
};

try{
  const lsArr=k=>{const v=JSON.parse(localStorage.getItem(k)||'[]');return Array.isArray(v)?v:[];};
  questions=lsArr('ghdd_questions');
  questionBank=lsArr('ghdd_bank');
  exams=lsArr('ghdd_exams');
}catch(_){}
try{renderQuestions();renderBank();}catch(initError){console.error('Init render failed:',initError);}
window.__ghddReady=true;


// ---------- Word (.docx) download of the exam / answer key ----------
// Real .docx (OOXML) built by docx-export.js; SVG diagrams are embedded as high-resolution PNG pictures.
let wordExamTitle='Exam';
// Word exporter files are loaded only when needed, so a missing file can never break the rest of the app.
async function loadJsText(url){
  const r=await fetch(url,{cache:'no-cache'});
  if(!r.ok)throw new Error(url+' ('+r.status+')');
  const t=await r.text();
  if(/^\s*</.test(t))throw new Error(url+' lama helin (server-ku wuxuu soo celiyay HTML)');
  const s=document.createElement('script');s.text=t;document.head.appendChild(s);
}
async function ensureDocxExporter(){
  if(typeof window.buildExamDocx==='function')return;
  if(!window.docx){
    try{await loadJsText('/vendor/docx.iife.js?v=9.8.1');}
    catch(_){try{await loadJsText('https://cdn.jsdelivr.net/npm/docx@9.8.1/dist/index.iife.js');}catch(__){}}
  }
  if(!window.docx)throw new Error('Maktabadda docx lama helin. Geli faylka public/vendor/docx.iife.js oo dib u deploy garee.');
  try{await loadJsText('/docx-export.js?v=r22');}
  catch(e){throw new Error('Hubi in faylka public/docx-export.js la geliyay. '+e.message);}
  if(typeof window.buildExamDocx!=='function')throw new Error('docx-export.js si sax uma shaqeynin.');
}
async function downloadExamWord(which){
  if(!$('studentPaper')){return alert('Marka hore samee ama fur imtixaanka.');}
  await ensureDocxExporter();
  const parts=[];
  if(which!=='key')parts.push($('studentPaper').cloneNode(true));
  if(which!=='exam'&&$('keyPaper')){const k=$('keyPaper').cloneNode(true);k.removeAttribute('style');parts.push(k);}
  const blob=await window.buildExamDocx(parts,{title:wordExamTitle});
  const suffix=which==='key'?'_answer-key':which==='both'?'_exam+key':'';
  const fname=(String(wordExamTitle||'Exam').replace(/[\\/:*?"<>|]+/g,'').trim().replace(/\s+/g,'_')||'Exam')+suffix+'.docx';
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=fname;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1500);
}
document.addEventListener('click',async e=>{
  const b=e.target.closest&&e.target.closest('.word-dl');if(!b)return;
  e.preventDefault();
  const old=b.textContent;b.disabled=true;b.textContent='⏳ Waa la diyaarinayaa…';
  try{
    if(b.dataset.rebuild==='1'){
      if(!questions.length){alert('Ku dar su’aalo marka hore.');return;}
      const meta=lastGenerated||{};
      buildPrintRoot({lang:meta.lang||currentExamLang(),examTitle:$('examName').value,subject:$('subject').value,className:$('className').value,normalized:questions,passage:meta.passage,instructions:$('examInstructions').value});
    }
    await downloadExamWord(b.dataset.which||'exam');
  }catch(err){alert('Word: '+err.message);}
  finally{b.disabled=false;b.textContent=old;}
});
