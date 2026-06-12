# Edit Unovac (Tibor) - Referral System

Referral sistem za webinar prijave. Jedan signup = lični referral link. Korisnik
deli link, prijave preko njegovog linka se broje, dashboard prikazuje broj
dovedenih + leaderboard (top 50).

Adaptirano sa naucidizajn referral sistema, Supabase-only mod (bez Kit-a -
Tibor koristi GHL/AEvent za emailove).

## Arhitektura

```
Optin (GHL: /optin-970758)
  └─ snippets/optin-head.html - hvata ?r=KOD → localStorage; na submit forme
     VALIDIRA i ODMAH šalje POST → /api/signup (referral se beleži na optinu!)
     + stash ime/email za thank-you widget
        │  custom forma redirectuje sa ?email=&phone=&first_name=
        ▼
Application (GHL: /application-old - Typeform)
  └─ snippets/application-head.html - stash email/ime iz URL-a → localStorage
        ▼
Thank-you (GHL: /thank-you-cta)
  └─ snippets/thankyou-embed.html - widget:
        ├─ čita email/ime (URL → localStorage), ref kod (localStorage)
        ├─ POST → /api/signup - idempotentan: vraća VEĆ KREIRAN ref_code sa optina
        └─ renderuje: "TVOJ REFERRAL LINK [Kopiraj]" + link na dashboard

Dashboard (Vercel: / → dashboard/index.html, pristup sa ?t=TOKEN)
  └─ GET rpc/get_dashboard + rpc/get_leaderboard (Supabase publishable key)
  └─ prikazuje: broj dovedenih, rank, moja lista, top 50 lestvica
```

## Repo layout

```
supabase/schema.sql            ← pokreni JEDNOM u Supabase SQL Editor-u
api/signup.js                  ← Vercel serverless function (POST /api/signup)
api/analyze.js                 ← Vercel serverless function (POST /api/analyze) - AI analiza kviza
dashboard/index.html           ← dashboard + leaderboard (servira se na /?t=TOKEN)
kviz/index.html                ← AI kviz + kalkulator zarade (servira se na /kviz)
snippets/optin-head.html       ← GHL Optin step → head tracking code
snippets/application-head.html ← GHL Application step → head tracking code
snippets/thankyou-embed.html   ← GHL Thank You step → custom HTML/JS element
```

## Deploy

### 1. Supabase (projekat: "Tibor | Referral System")

1. SQL Editor → New query → pejstuj ceo `supabase/schema.sql` → Run.
2. Ključevi (Settings → API): Project URL + publishable (sb_publishable_) + secret (sb_secret_).
   - publishable je već u `dashboard/index.html` i javan je po dizajnu
   - secret ide SAMO u Vercel env vars

### 2. Vercel

1. New Project → Import `floumate/tibor-referral-system` (Framework: Other, bez build podešavanja).
2. Environment Variables:

   | Variable | Vrednost |
   |---|---|
   | `SUPABASE_URL` | `https://qdllfhjlibyvwntwknkg.supabase.co` |
   | `SUPABASE_SECRET_KEY` | `sb_secret_...` (iz Supabase Settings → API keys) |
   | `WEBINAR_LANDING_URL` | `https://uzivotrening.editunovac.com/optin-970758` |
   | `DASHBOARD_BASE_URL` | deploy URL (npr. `https://tibor-referral-system.vercel.app`) |

3. Deploy. Proveri stvarni deploy URL - ako NIJE `tibor-referral-system.vercel.app`,
   ažuriraj `CONFIG.apiUrl` i `CONFIG.dashboardBaseUrl` u `snippets/thankyou-embed.html`
   i `DASHBOARD_BASE_URL` env var.

### 3. GHL funnel (01 - Webinar)

1. **Optin step** → Settings → Tracking Code → Head → pejstuj `snippets/optin-head.html`.
2. **Application step** → isto → pejstuj `snippets/application-head.html`.
3. **Thank You step** → dodaj Custom JS/HTML element → pejstuj `snippets/thankyou-embed.html`.
4. Publish funnel.

## Testiranje

1. **Supabase smoke test** (SQL Editor):
   ```sql
   select * from create_signup('test@test.com', 'Test', null, 'User');
   select * from signups;
   ```
2. **Dashboard**: otvori `https://<deploy-url>/?t=<dashboard_token iz koraka 1>`.
   Vidiš "Pozdrav, Test!" + prazan spisak. (`/?demo=1` za demo prikaz bez baze.)
3. **End-to-end**: otvori optin sa `?r=<ref_code iz koraka 1>` u privatnom prozoru,
   prijavi se drugim emailom, prođi do thank-you → widget pokazuje NJEGOV novi link;
   u Supabase novi red sa `referred_by = <tvoj kod>`; tvoj dashboard pokazuje 1.
4. **Edge cases**: isti email 2x → jedan red, isti kod; `?r=GLUPOST` → prijava
   prolazi, `referred_by = null`.

## Posle webinara - izbor pobednika (TOP 3)

Nagrade idu 3 najbolja na lestvici. Isto što dashboard prikazuje kao Top 3:

```sql
-- TOP 3 po broju dovedenih:
select s.email, s.first_name, s.last_name, s.ref_code,
       (select count(*) from signups x where x.referred_by = s.ref_code) as cnt
from signups s
where (select count(*) from signups x where x.referred_by = s.ref_code) >= 1
order by cnt desc, s.first_name
limit 3;

-- (opciono) svi koji su prešli prag od 5 = ušli u trku:
select s.email, s.first_name, s.ref_code,
       (select count(*) from signups x where x.referred_by = s.ref_code) as cnt
from signups s
where (select count(*) from signups x where x.referred_by = s.ref_code) >= 5
order by cnt desc;

-- označi isporučene nagrade:
update signups set reward_sent = true where email in ('...');
```

## Mehanika i nagrade (Tibor, finalno)

- **Prag = 5** (`THRESHOLD` u `dashboard/index.html`): dovedeš 5 prijava → ulaziš u
  trku. Dashboard ispod 5 prikazuje progress bar `X / 5`; na/iznad 5 prelazi u
  „U trci si“ stanje sa istaknutim rankom.
- **Nagrade = TOP 3 na lestvici** (`PRIZES` u `dashboard/index.html`):
  1. mjesto - Pronaći ću ti klijenta · 2. i 3. mjesto - 30 min 1:1 poziv sa Tiborom.
- **Isporuka = manual** (lične nagrade). Posle webinara uzmeš top 3 sa lestvice
  (SQL gore). Nema auto-winner taga.

## Share linkovi (Hyros/AEvent atribucija)

Share link = bazni optin URL (`/optin`) sa atribucijskim parametrima + naš `&r=KOD`.
Dvije varijante razlikuju se samo po `el=` (odakle je link podijeljen):

- **Thank-you widget** (`CONFIG.shareBase` u `snippets/thankyou-embed.html`):
  `…/optin?el=referral_[webinar]_url_thankyou&hgoal=webinar&htrafficsource=referral&source=referral`
- **Dashboard kopiranje** (`SHARE_BASE` u `dashboard/index.html`):
  `…/optin?el=referral_[webinar]_url_platform&hgoal=webinar&htrafficsource=referral&source=referral`

`[webinar]` je doslovan label po dogovoru - ako treba stvarni naziv webinara, zameni na
obje površine. `optin-head.html` čita samo `?r=`; ostali parametri su za Hyros.

## AI kviz + kalkulator (/kviz)

Nagrada za 5 preporuka (brief: `brief-kviz-kalkulator`). Stranica `/kviz` vodi korisnika kroz:

1. **Kviz** - 8 MBTI pitanja (2 po osi, iz brief-a) + 4 domain pitanja (sati tjedno,
   kreativa vs. pričanje, svoja vještina vs. tuđi offer, brzo vs. dugoročno).
2. **AI analiza** (`POST /api/analyze`) - Claude API server-side generira: tip osobnosti
   + nadimak, personality readout, rang listu 5 online poslova (score, zašto, zarada,
   plusevi/minusi) i prijelaznu rečenicu u kalkulator. `temperature: 1` + ime + random
   seed = svaki korisnik dobija DRUGAČIJI tekst i brojke (prijatelji porede rezultate!).
   Edge case iz brief-a: ako odgovori stvarno ne pašu editingu, AI ne forsira editing.
   Ako AI padne/nema ključa, frontend ima lokalni fallback pa stranica uvek radi.
3. **Kalkulator zarade** - default `55.5€ x 30 videa x 2 klijenta = 3.330€ mjesečno`
   → dnevno tačno **111€** (kampanja je obećala 111, zato 55.5 a ne 55).
4. **CTA** - podsetnik na webinar.

Env vars (Vercel):

| Variable | Vrednost |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` (console.anthropic.com → API keys) |
| `ANTHROPIC_MODEL` | opciono, default `claude-haiku-4-5-20251001` |

Otključavanje na 5 dovedenih: link na `/kviz` se šalje kroz GHL winner workflow
(GHL_WINNER_TAG u `api/signup.js` okida na pragu 5) - stranica je noindex i ne
linkuje se javno.

## Gotchas

- **CORS**: dozvoljeni origini su hardkodirani u `api/signup.js` (`ALLOWED_ORIGINS`) -
  dodaj novi domen ako se funnel seli.
- **Email korisnika je jedini ključ identiteta** - ista osoba sa drugim emailom = novi red.
- **Niko ne šalje dashboard link emailom** (nema Kit-a) - korisnik ga dobija SAMO na
  thank-you stranici. Ako zatreba, dodati GHL automatizaciju koja šalje link.
- **Supabase free tier pauzira projekat posle ~7 dana neaktivnosti** - pre kampanje
  proveri da je projekat aktivan (dashboard → Restore ako treba).
