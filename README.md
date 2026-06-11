# Edit Unovac (Tibor) — Referral System

Referral sistem za webinar prijave. Jedan signup = lični referral link. Korisnik
deli link, prijave preko njegovog linka se broje, dashboard prikazuje broj
dovedenih + leaderboard (top 50).

Adaptirano sa naucidizajn referral sistema, Supabase-only mod (bez Kit-a —
Tibor koristi GHL/AEvent za emailove).

## Arhitektura

```
Optin (GHL: /uzivo-trening-old)
  └─ snippets/optin-head.html — hvata ?r=KOD → localStorage, stash ime/email na submit
        │  custom forma redirectuje sa ?email=&phone=&first_name=
        ▼
Application (GHL: /application — Typeform)
  └─ snippets/application-head.html — stash email/ime iz URL-a → localStorage
        ▼
Thank-you (GHL: /thank-you)
  └─ snippets/thankyou-embed.html — widget:
        ├─ čita email/ime (URL → localStorage), ref kod (localStorage)
        ├─ POST → /api/signup (Vercel) → upsert u Supabase → vraća ref_code + linkove
        └─ renderuje: "TVOJ REFERRAL LINK [Kopiraj]" + link na dashboard

Dashboard (Vercel: / → dashboard/index.html, pristup sa ?t=TOKEN)
  └─ GET rpc/get_dashboard + rpc/get_leaderboard (Supabase anon key)
  └─ prikazuje: broj dovedenih, rank, moja lista, top 50 lestvica
```

## Repo layout

```
supabase/schema.sql          ← pokreni JEDNOM u Supabase SQL Editor-u
api/signup.js                ← Vercel serverless function (POST /api/signup)
dashboard/index.html         ← dashboard + leaderboard (servira se na /?t=TOKEN)
snippets/optin-head.html     ← GHL Optin step → head tracking code
snippets/application-head.html ← GHL Application step → head tracking code
snippets/thankyou-embed.html ← GHL Thank You step → custom HTML/JS element
```

## Deploy

### 1. Supabase (projekat: "Tibor | Referral System")

1. SQL Editor → New query → pejstuj ceo `supabase/schema.sql` → Run.
2. Ključevi (Settings → API): Project URL + publishable (anon) + secret (service_role).
   - publishable je već u `dashboard/index.html` i javan je po dizajnu
   - secret ide SAMO u Vercel env vars

### 2. Vercel

1. New Project → Import `floumate/tibor-referral-system` (Framework: Other, bez build podešavanja).
2. Environment Variables:

   | Variable | Vrednost |
   |---|---|
   | `SUPABASE_URL` | `https://qdllfhjlibyvwntwknkg.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_...` (iz Supabase Settings → API) |
   | `WEBINAR_LANDING_URL` | `https://uzivotrening.editunovac.com/uzivo-trening-old` |
   | `DASHBOARD_BASE_URL` | deploy URL (npr. `https://tibor-referral-system.vercel.app`) |

3. Deploy. Proveri stvarni deploy URL — ako NIJE `tibor-referral-system.vercel.app`,
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

## Posle webinara — izvlačenje pobednika/nagrada

```sql
-- svi sa bar N dovedenih (zameni 5 pravim pragom):
select s.email, s.first_name, s.last_name, s.ref_code,
       (select count(*) from signups x where x.referred_by = s.ref_code) as cnt
from signups s
where (select count(*) from signups x where x.referred_by = s.ref_code) >= 5
  and s.reward_sent = false
order by cnt desc;

-- označi isporučene nagrade:
update signups set reward_sent = true where email in ('...');
```

## Placeholderi (čeka se Tibor)

- **Prag/nagrada**: `REWARD_TEXT` u `dashboard/index.html` + tekst u thankyou widgetu.
- **Landing URL**: trenutno stari page (`/uzivo-trening-old`) — pri prelasku na novi
  webinar page promeni `WEBINAR_LANDING_URL` (Vercel env), `CONFIG.webinarUrl`
  (thankyou-embed) i `WEBINAR_LANDING_URL` (dashboard/index.html), i preseli snippete
  u nove funnel stepove.

## Gotchas

- **CORS**: dozvoljeni origini su hardkodirani u `api/signup.js` (`ALLOWED_ORIGINS`) —
  dodaj novi domen ako se funnel seli.
- **Email korisnika je jedini ključ identiteta** — ista osoba sa drugim emailom = novi red.
- **Niko ne šalje dashboard link emailom** (nema Kit-a) — korisnik ga dobija SAMO na
  thank-you stranici. Ako zatreba, dodati GHL automatizaciju koja šalje link.
- **Supabase free tier pauzira projekat posle ~7 dana neaktivnosti** — pre kampanje
  proveri da je projekat aktivan (dashboard → Restore ako treba).
