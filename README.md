# Edit Unovac (Tibor) â€” Referral System

Referral sistem za webinar prijave. Jedan signup = liÄni referral link. Korisnik
deli link, prijave preko njegovog linka se broje, dashboard prikazuje broj
dovedenih + leaderboard (top 50).

Adaptirano sa naucidizajn referral sistema, Supabase-only mod (bez Kit-a â€”
Tibor koristi GHL/AEvent za emailove).

## Arhitektura

```
Optin (GHL: /uzivo-trening-old)
  â””â”€ snippets/optin-head.html â€” hvata ?r=KOD â†’ localStorage, stash ime/email na submit
        â”‚  custom forma redirectuje sa ?email=&phone=&first_name=
        â–¼
Application (GHL: /application â€” Typeform)
  â””â”€ snippets/application-head.html â€” stash email/ime iz URL-a â†’ localStorage
        â–¼
Thank-you (GHL: /thank-you)
  â””â”€ snippets/thankyou-embed.html â€” widget:
        â”œâ”€ Äita email/ime (URL â†’ localStorage), ref kod (localStorage)
        â”œâ”€ POST â†’ /api/signup (Vercel) â†’ upsert u Supabase â†’ vraÄ‡a ref_code + linkove
        â””â”€ renderuje: "TVOJ REFERRAL LINK [Kopiraj]" + link na dashboard

Dashboard (Vercel: / â†’ dashboard/index.html, pristup sa ?t=TOKEN)
  â””â”€ GET rpc/get_dashboard + rpc/get_leaderboard (Supabase anon key)
  â””â”€ prikazuje: broj dovedenih, rank, moja lista, top 50 lestvica
```

## Repo layout

```
supabase/schema.sql          â† pokreni JEDNOM u Supabase SQL Editor-u
api/signup.js                â† Vercel serverless function (POST /api/signup)
dashboard/index.html         â† dashboard + leaderboard (servira se na /?t=TOKEN)
snippets/optin-head.html     â† GHL Optin step â†’ head tracking code
snippets/application-head.html â† GHL Application step â†’ head tracking code
snippets/thankyou-embed.html â† GHL Thank You step â†’ custom HTML/JS element
```

## Deploy

### 1. Supabase (projekat: "Tibor | Referral System")

1. SQL Editor â†’ New query â†’ pejstuj ceo `supabase/schema.sql` â†’ Run.
2. KljuÄevi (Settings â†’ API): Project URL + publishable (anon) + secret (sb_secret_).
   - publishable je veÄ‡ u `dashboard/index.html` i javan je po dizajnu
   - secret ide SAMO u Vercel env vars

### 2. Vercel

1. New Project â†’ Import `floumate/tibor-referral-system` (Framework: Other, bez build podeÅ¡avanja).
2. Environment Variables:

   | Variable | Vrednost |
   |---|---|
   | `SUPABASE_URL` | `https://qdllfhjlibyvwntwknkg.supabase.co` |
   | `SUPABASE_SECRET_KEY` | `sb_secret_...` (iz Supabase Settings â†’ API) |
   | `WEBINAR_LANDING_URL` | `https://uzivotrening.editunovac.com/uzivo-trening-old` |
   | `DASHBOARD_BASE_URL` | deploy URL (npr. `https://tibor-referral-system.vercel.app`) |

3. Deploy. Proveri stvarni deploy URL â€” ako NIJE `tibor-referral-system.vercel.app`,
   aÅ¾uriraj `CONFIG.apiUrl` i `CONFIG.dashboardBaseUrl` u `snippets/thankyou-embed.html`
   i `DASHBOARD_BASE_URL` env var.

### 3. GHL funnel (01 - Webinar)

1. **Optin step** â†’ Settings â†’ Tracking Code â†’ Head â†’ pejstuj `snippets/optin-head.html`.
2. **Application step** â†’ isto â†’ pejstuj `snippets/application-head.html`.
3. **Thank You step** â†’ dodaj Custom JS/HTML element â†’ pejstuj `snippets/thankyou-embed.html`.
4. Publish funnel.

## Testiranje

1. **Supabase smoke test** (SQL Editor):
   ```sql
   select * from create_signup('test@test.com', 'Test', null, 'User');
   select * from signups;
   ```
2. **Dashboard**: otvori `https://<deploy-url>/?t=<dashboard_token iz koraka 1>`.
   VidiÅ¡ "Pozdrav, Test!" + prazan spisak. (`/?demo=1` za demo prikaz bez baze.)
3. **End-to-end**: otvori optin sa `?r=<ref_code iz koraka 1>` u privatnom prozoru,
   prijavi se drugim emailom, proÄ‘i do thank-you â†’ widget pokazuje NJEGOV novi link;
   u Supabase novi red sa `referred_by = <tvoj kod>`; tvoj dashboard pokazuje 1.
4. **Edge cases**: isti email 2x â†’ jedan red, isti kod; `?r=GLUPOST` â†’ prijava
   prolazi, `referred_by = null`.

## Posle webinara â€” izvlaÄenje pobednika/nagrada

```sql
-- svi sa bar N dovedenih (zameni 5 pravim pragom):
select s.email, s.first_name, s.last_name, s.ref_code,
       (select count(*) from signups x where x.referred_by = s.ref_code) as cnt
from signups s
where (select count(*) from signups x where x.referred_by = s.ref_code) >= 5
  and s.reward_sent = false
order by cnt desc;

-- oznaÄi isporuÄene nagrade:
update signups set reward_sent = true where email in ('...');
```

## Placeholderi (Äeka se Tibor)

- **Prag/nagrada**: `REWARD_TEXT` u `dashboard/index.html` + tekst u thankyou widgetu.
- **Landing URL**: trenutno stari page (`/uzivo-trening-old`) â€” pri prelasku na novi
  webinar page promeni `WEBINAR_LANDING_URL` (Vercel env), `CONFIG.webinarUrl`
  (thankyou-embed) i `WEBINAR_LANDING_URL` (dashboard/index.html), i preseli snippete
  u nove funnel stepove.

## Gotchas

- **CORS**: dozvoljeni origini su hardkodirani u `api/signup.js` (`ALLOWED_ORIGINS`) â€”
  dodaj novi domen ako se funnel seli.
- **Email korisnika je jedini kljuÄ identiteta** â€” ista osoba sa drugim emailom = novi red.
- **Niko ne Å¡alje dashboard link emailom** (nema Kit-a) â€” korisnik ga dobija SAMO na
  thank-you stranici. Ako zatreba, dodati GHL automatizaciju koja Å¡alje link.
- **Supabase free tier pauzira projekat posle ~7 dana neaktivnosti** â€” pre kampanje
  proveri da je projekat aktivan (dashboard â†’ Restore ako treba).
