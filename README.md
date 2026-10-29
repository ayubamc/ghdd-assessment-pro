# GHDD – Nidaamka Natiijada Imtixaanka Form 4

Nidaam online + offline ah oo GHDD ku maamusho natiijada imtixaanka Fasalka 4aad ee dugsiyada.

## Waxa uu qabto
- **Diiwaangelinta ardayda** (gacan ama Excel) – arday kasta wuxuu helaa **Roll Number serial ah** (tusaale `260001`) oo marnaba arday kale lama siiyo, xitaa haddii ardayga la joojiyo.
- **Passcard** la daabici karo (8 kaar bog A4 kasta) oo leh **QR code** lagu xaqiijiyo kaarka.
- **Gelinta dhibcaha** maaddo-maaddo (taleefanka) ama **Excel template** – waxay shaqaysaa offline, marka internet-ku yimaado ayay iskood u gudbaan.
- **Bogga natiijada ardayga** (`/natiijo`): Roll Number + taleefanka waalidka → warqad natiijo oo leh gudbay/haray, grade, kaalinta, iyo talo waalid.
- **Falanqayn**: heer GHDD, heer dugsi, heer maaddo iyo heer arday; jaantusyo; isbarbardhigga dugsiyada; wiil/gabar; 10-ka ugu sarreeya; warbixin Excel ah iyo daabacaad.
- **Grade system** iyo xeerka gudbitaanka oo laga beddeli karo Dejinta.
- Sii daynta / xiridda natiijada, diiwaanka isbeddellada (audit log), kayd (backup) iyo soo celin.

## Bogagga
| Link | Ujeedo |
|---|---|
| `/admin` | Maamulka GHDD |
| `/natiijo` | Ardayda: eeg natiijada |
| `/kaar/<token>` | Xaqiijinta passcard-ka (QR) |

## Dejinta server-ka (environment variables)
| Magac | Sharaxaad |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon, Railway…). Haddii aan la helin, SQLite maxalli ah ayaa la isticmaalaa. |
| `ADMIN_PASSWORD` | Furaha ugu horreeya ee maamulka (kadib waxaa laga beddeli karaa Dejinta). |
| `RESET_ADMIN_PASSWORD` | Haddii furaha la ilaawo: geli furaha cusub, dib u bilow, kadib ka saar. |

Bilaabid: `npm install && npm start` (Node 22.13+).
