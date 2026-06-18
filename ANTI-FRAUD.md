# ANTI-FRAUD — pouke iz Tibor webinara (čitaj pre nego praviš novi referral sistem)

> Ako praviš novi referral sistem za drugog klijenta po ovom template-u:
> **OBAVEZNO ugradi anti-fraud od početka.** Ovaj fajl objašnjava zašto i kako.

## Šta se desilo (Tibor, jun 2026)

Referral akcija "dovedi 5 ljudi na webinar = nagrada" je bila **masovno izgejmovana**.
Ljudi su shvatili da se rang pravi po broju prijava, pa su sami ručno upisivali
lažna imena/emailove da skoče na vrh lestvice:

- **Borna Hrkač:** 102 "prijave", ali **87 sa JEDNOG istog IP-a**, jedna na ~30 sekundi,
  2 sata u nizu. Email-ovi tipa `lol123@gmail.com`, `volimkadjeb@gmail.com`, imena
  "volim muška jaja". Na webinar došlo **0** od 102.
- Više drugih sa istim obrascem (npr. "Milica" — 6 prijava, svi email-ovi đubre).

Sirovi leaderboard je bio bezvredan. Pravu sliku smo dobili TEK posle webinara,
ručnim ukrštanjem sa CSV-om prisustva (attendance) + IP analizom iz tog CSV-a.
**Ne želimo da sledeći put zavisimo od ručnog čišćenja.**

## Signali za prevaru — i njihove mane (nijedan nije savršen sam)

| Signal | Hvata | Mana |
|---|---|---|
| **IP adresa prijave** | rafal sa istog uređaja (Borna) | mobilni internet (CGNAT) deli 1 IP na hiljade pravih ljudi; škola/dom/porodica isti WiFi |
| **Rafal (burst) po vremenu** | mnogo prijava u kratkom roku | — (najjači at-signup signal) |
| **Honeypot polje** | proste botove | ne hvata ručno kucanje |
| **Email pattern** | očigledno đubre (`hdsxcb@`, `1@`) | teško automatski pouzdano |
| **PRISUSTVO (attended)** | NAJPOUZDANIJE — bot se ne pojavi na webinaru | znaš tek POSLE webinara |

### Ključ: ISTI IP != prevara. RAFAL sa istog IP-a = prevara.

Zbog CGNAT-a (mobilni operater gura hiljade korisnika kroz jednu javnu IP), ne smeš
da kažeš "ista IP = lažno" — lažno bi okrivio prave ljude na istom operateru. Razlika
između Borne i CGNAT-a nije DELJENJE IP-a, nego **količina + ritam**:

- Borna: 87 prijava / 1 IP / metronomski ritam / 2h → jedan čovek za tastaturom.
- CGNAT: 3-5 nepoznatih ljudi / 1 IP / raštrkani kroz dane / prava imena → normalno.

Zato pravilo treba da bude **rate-limit na rafal**, ne ban na isti IP.

## Šta je VEĆ ugrađeno u ovaj template

1. **Hvatanje IP-a** (`api/signup.js`): čita `x-forwarded-for` (server-side, korisnik
   ga ne može lažirati) i upisuje u `signups.ip` + `signups.user_agent`.
2. **Kolone** `ip`, `user_agent` u `signups` (+ index na `ip`) — vidi `supabase/schema.sql`.
3. **Honeypot** anti-bot u `snippets/optin-head.html`.

## Šta DODATI po potrebi (preporučeno za nove klijente)

### A) Rate-limit na rafal (blokira Bornu PRE nego uđe u bazu)

U `create_signup` funkciji, pre inserta, odbij ako je sa istog IP-a stiglo previše
prijava u kratkom roku. Prag biraj blago (CGNAT!) — npr. max 6 na sat:

```sql
if p_ip is not null and (
  select count(*) from signups
  where ip = nullif(trim(p_ip), '')
    and created_at > now() - interval '1 hour'
) >= 6 then
  raise exception 'rate_limited';
end if;
```

`api/signup.js` već gleda `supabase_error` — možeš da uhvatiš ovu poruku i vratiš
tih 200 (da ne kvariš UX), prijava se prosto ne upiše.

### B) Detekcija prevare DIREKTNO u Supabase (posle, za dodelu nagrada)

Sa popunjenom `ip` kolonom, fraud se nalazi bez ikakvog CSV-a:

```sql
-- Referreri sa rafal-obrascem: koliko prijava deli isti IP
select s.first_name, s.last_name, s.email,
       count(r.*) as dovedenih,
       count(distinct r.ip) as razlicitih_ip,
       max(cnt.c) as najveci_klaster_isti_ip
from signups s
join signups r on r.referred_by = s.ref_code
join lateral (
  select count(*) c from signups x
  where x.referred_by = s.ref_code and x.ip = r.ip
) cnt on true
group by s.id
order by najveci_klaster_isti_ip desc;
-- veliki "najveci_klaster_isti_ip" (npr. 87) = prevara (Borna).
-- "razlicitih_ip" blizu "dovedenih" = pravi ljudi (svako sa svog uredjaja).
```

### C) Posle webinara: ukrsti sa prisustvom (attendance)

Najpouzdanija provera za nagrade je "ko je doveo ljude koji su se POJAVILI".
Webinar platforma (AEvent/GHL) izvozi CSV sa kolonom `Attended` i `Ip Address`.
Skripta za ukrštanje (Tibor primer): vidi git istoriju / pitaj korisnika za
`registrant-download` CSV. Bot se ne pojavi → attended = najjači filter.

## TL;DR za nagrade

1. **Pre webinara:** IP rate-limit + honeypot drže ~90% rafala napolju.
2. **Za dodelu:** ukrsti sa prisustvom (attended) — to je istina. Ako baš moraš po
   prijavama, prvo izbaci sve sa velikim same-IP klasterom (SQL pod B).
3. **Nikad** ne deli nagrade po sirovom broju prijava bez filtera.
