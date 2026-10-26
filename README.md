
# GHDD Assessment Pro

**Golaha Horumarinta Dugsiyada Dadweynaha (GHDD)**

Nidaam lagu horumarinayo tayada diyaarinta, kaydinta iyo falanqaynta imtixaannada dugsiyada dadweynaha.

## 1. Ujeeddada App-ka

GHDD Assessment Pro waxaa loogu talagalay in lagu taageero:
- Diyaarinta imtixaannada.
- Qorshaynta Exam Blueprint.
- Kaydinta iyo maaraynta su'aalaha.
- Kaydinta xogta imtixaannada PostgreSQL.
- Falanqaynta hordhaca ah ee tayada imtixaannada.
- Horumarinta isku-mid ahaanshaha imtixaannada dugsiyada.

## 2. Qaab-dhismeedka Faylasha

Repository-gu waa inuu lahaadaa qaabkan:

```text
ghdd-assessment-pro/
├── server.js
├── package.json
├── README.md
└── Public/
    ├── index.html
    ├── app.js
    ├── style.css
    └── letterhead.jpg
```

**Muhiim:** Magaca `Public` waa inuu la mid noqdaa kan GitHub ku qoran, haddii aan la beddelin. Server-ku waa inuu helaa `index.html` gudaha folder-kaas.

## 3. Tiknoolajiyada

- HTML
- CSS
- JavaScript
- Node.js
- Express.js
- PostgreSQL
- Railway
- GitHub

## 4. Ku Rakibidda

Waxyaabaha loo baahan yahay:
- Node.js
- npm
- PostgreSQL database
- GitHub repository

Ku rakib dependencies-ka:

```bash
npm install
```

Bilow server-ka:

```bash
npm start
```

## 5. Railway Deployment

1. Ku xidh GitHub repository-ga Railway.
2. Hubi in Root Directory-gu yahay meesha `package.json` iyo `server.js` yaallaan.
3. Ku dar PostgreSQL service.
4. Hubi in `DATABASE_URL` lagu xiray app-ka.
5. Ku dar `ADMIN_PASSWORD` gudaha Railway Variables.
6. Hubi Deploy Logs.
7. Fur domain-ka app-ka marka deployment-ku guuleysto.

## 6. Environment Variables

App-ku wuxuu u baahan yahay:

```text
DATABASE_URL=<Railway PostgreSQL connection URL>
ADMIN_PASSWORD=<Strong unique admin password>
```

`PORT` waxaa si otomaatig ah u dejin kara Railway.

Ha gelin furaha maamulka ama xogta sirta ah gudaha GitHub.

## 7. Database

Server-ku wuxuu diyaarin karaa jadwallada:
- `assessments`
- `question_bank`

Database-ku waa inuu diyaar yahay, `DATABASE_URL`-kuna waa inuu sax yahay ka hor inta aan la adeegsan hawlaha kaydinta.

## 8. API-ga

API-yada aasaasiga ah waxaa ka mid ah:

- `GET /api/health` — hubinta xaaladda server-ka.
- `POST /api/login` — xaqiijinta furaha maamulka.
- `POST /api/assessments` — kaydinta imtixaan.
- `GET /api/assessments` — soo qaadashada imtixaannada.
- `POST /api/question-bank` — kaydinta su'aalaha.
- `GET /api/question-bank` — soo qaadashada su'aalaha.

Hawlaha maamulka waxay u baahan yihiin xaqiijinta `ADMIN_PASSWORD`.

## 9. Xaqiijinta Tayada

Ka hor isticmaalka rasmiga ah:
- Hubi in dhammaan faylasha frontend-ku jiraan.
- Hubi in boggu furmayo.
- Tijaabi kaydinta iyo soo qaadashada xogta.
- Hubi in jawaabaha su'aalaha la xaqiijiyey.
- Samee tijaabooyin amni iyo kayd-celin xogeed.

Su'aalaha uu nidaamku diyaariyo waa in macallin ama guddi imtixaan dib u eego ka hor isticmaalka rasmiga ah.

## 10. Maamulka Mashruuca

**Magaca:** GHDD Assessment Pro  
**Hay'adda:** Golaha Horumarinta Dugsiyada Dadweynaha (GHDD)

Ujeeddada guud waa in la horumariyo tayada, caddaaladda iyo isku-habboonaanta imtixaannada dugsiyada dadweynaha.

## 11. Xeerarka Qoritaanka Su'aalaha (cusub)

- **Xisaabta:** su'aalaha maadada xisaabta waxaa lagu qoraa qaab nadiif ah, sida buugga manhajka ugu qoran (tusaale: `x²`, `3/4`, `√16`, `45°`). Lama oggola LaTeX (`$`, `\frac`), markdown (`**`) ama calaamado aan loo baahnayn; server-ku wuu nadiifiyaa haddii AI-gu soo geliyo.
- **Xigasho la'aan:** su'aasha waxaa la weydiiyaa si toos ah. Lama oggola "bogga 5aad", "(p. 7)", "sida buugga ku qoran" iwm. Bogagga isha waxay ku jiraan xogta macallinka (`sourcePages`) oo keliya, kamana soo muuqdaan warqadda ardayga.
- **Qidcada (passage):** MCQ-yada qaybta 1aad waxaa laga soo saaraa qidcada, iyadoo lagu saleynayo ujeeddooyinka manhajka (naxwaha, ereyada, isku-micnaha iyo ka-soo-horjeedka, balaaqada, higgaadda iyo calaamadaynta). Ugu yaraan 70% waa xirfado luqadeed; ugu badnaan 30% waa faham guud.

## 12. Word (.docx) dhab ah

Badhamada "Soo deji Word" waxay hadda sameeyaan fayl **.docx** dhab ah (`public/docx-export.js` + `public/vendor/docx.iife.js`). Jaantusyada SVG waxaa loo beddelaa sawirro PNG oo xallin sare leh, waxayna ku jiraan gudaha faylka, sidaa darteed waxay si cad ugu muuqdaan Word, LibreOffice iyo PDF. Arabic (RTL) waa la taageeraa.

## 13. Habka Sawirrada Caqli-badan (cusub)

Waxaa lagu daray 3 fayl oo cusub (root-ka, server.js agtiisa): `exam-profiles.js`, `figure-engine.js`, `smart-figures.js`.

1. **Profile-ka qaranka** (`exam-profiles.js`): 12-ka maaddo ee sample-ka F4 2024-2025. Waxay hayaan qaab-dhismeedka (40 MCQ + qaybta 2aad), tirada sawirrada ee MCQ (`figureShare`) iyo noocyada sawirka ee maadada. Soomaali: 40 MCQ = 80 dhibcood + curis 20. `basis:'assumed'` = Arabic iyo Tarbiya si fudud ayaa loo eegay.
2. **Nooca su'aasha** (`chooseKindForObjective`): ujeeddada casharka ayaa go'aamisa MCQ qoraal / sawir / xisaabin / koodh / qoraal.
3. **Sawirka saxda ah** (`figure-engine.js`): AI-gu wuxuu bixiyaa SPEC (tirooyin), koodhkuna wuxuu sawiraa: vt_graph, wave, forces, right_triangle, bar/line/pie chart, data_table, logic_gate, flowchart, resistor_circuit, coord_line. Jawaabta waxaa laga xisaabiyaa sawirka (facts). Biology/Geography/map: maktabadda buugga (`book_diagrams`) ama AI-SVG, oo la calaamadeeyo "dib u eeg".
4. **Hubinta**: SVG dhammaystiran, canvas gudaheeda, calaamado is-qaban, jawaab muujin, furaha jawaabta (waa la saxaa), sawirka loo tixraacay; iyo hubinta aragga (`/api/figures/verify-vision`) ee sawirrada AI.
5. **Isticmaal**: Qaabka imtixaanka = "Qaabka Imtixaanka Qaranka", ama Habka sawirrada = "Caqli-badan". Haddii sawir fashilmo, su'aasha qoraalka ah ayaa hadhaysa (sawir jaban lama bixiyo).

API cusub: `GET /api/exam-profile`, `POST /api/figures/render`, `POST /api/figures/verify-vision`.
