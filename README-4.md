
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
