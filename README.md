Golaha Horumarinta Dugsiyada Dadweynaha (GHDD) — Digital Assessment & Exam Quality System v2.0
A more advanced successor to the Imtixaan-Sameeye app. It is designed around:
Exam Blueprint / Table of Specifications
Learning-outcome mapping
Bloom's Taxonomy
Difficulty balancing
AI question generation (optional Gemini)
Automatic question quality checks
Duplicate/similarity detection
Question Bank
Exam saving in PostgreSQL
Post-exam item analysis (difficulty index and discrimination)
GHDD branding
Mobile-friendly UI and print support
Run locally
npm install
ADMIN_PASSWORD=your-password DATABASE_URL=postgres://... GEMINI_API_KEY=... npm start
GEMINI_API_KEY is optional. Without it, the app produces clearly-labelled draft questions using an offline fallback; it does not pretend that those drafts are AI-generated.
Railway
Push this folder to GitHub.
Deploy the repository on Railway.
Add a PostgreSQL service.
Add variables: ADMIN_PASSWORD, DATABASE_URL (normally provided by Railway), and optionally GEMINI_API_KEY.
Deploy.
Recommended next phase
Add authenticated teacher accounts, curriculum/LO library, PDF/DOCX import + OCR, exam versions A/B/C, randomized student papers, secure answer-key export, printable official exam templates, detailed marking schemes, and longitudinal item statistics.
