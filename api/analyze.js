// Vercel serverless function: POST /api/analyze
// Poziva se sa /kviz stranice. Prima odgovore iz kviza (MBTI + domain pitanja),
// zove Claude API (Anthropic) server-side i vraća personalizovan rezultat:
// personality readout + rangirana lista online poslova (leaderboard stil).
//
// KLJUČNO (iz brief-a): output mora biti RAZLIČIT za svaku osobu - prijatelji
// koji su se međusobno doveli (referral) će uporediti rezultate. Zato:
//   - temperature 1.0
//   - ime + tačna kombinacija odgovora ulaze u prompt
//   - random "flavor" seed varira ugao/strukturu teksta
//
// ENV VARS REQUIRED:
//   ANTHROPIC_API_KEY   (sk-ant-... - server-only, NIKAD u frontend)
// ENV VARS OPCIONO:
//   ANTHROPIC_MODEL     (default: claude-haiku-4-5-20251001)

export const config = { runtime: 'nodejs' };

const ALLOWED_ORIGINS = [
  'https://uzivotrening.editunovac.com',
  'https://editunovac.com',
  'https://www.editunovac.com',
  'https://tibor-referral-system.vercel.app',
];

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'missing_api_key' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const name = cleanString(body.name).slice(0, 60);
  const mbti = cleanString(body.mbti).toUpperCase().slice(0, 4);
  const hours = cleanString(body.hours).slice(0, 20);
  const answers = Array.isArray(body.answers) ? body.answers.slice(0, 16) : [];

  if (!/^[EI][SN][TF][JP]$/.test(mbti) || answers.length < 8) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  const answersText = answers
    .map((a, i) => `${i + 1}. ${cleanString(a.q).slice(0, 200)}\n   Odgovor: ${cleanString(a.a).slice(0, 200)}`)
    .join('\n');

  // Random seed za varijaciju - osigurava da dvoje ljudi sa IDENTIČNIM
  // odgovorima dobije bitno drugačiji tekst (ugao + ton + stil se kombinuju).
  const flavor = Math.floor(Math.random() * 1000000);
  const angles = [
    'kreni od njegove energije i kako provodi dan',
    'kreni od toga što ga motivira i što ga frustrira',
    'kreni od njegovog stila donošenja odluka',
    'kreni od toga kako radi pod pritiskom i s rokovima',
    'kreni od njegovog odnosa prema slobodi i samostalnosti',
    'kreni od toga kako bira u što ulaže vrijeme',
    'kreni od toga kako se nosi s novim stvarima i učenjem',
  ];
  const tones = [
    'ton: smiren i analitičan, kao mentor koji ga dobro poznaje',
    'ton: energičan i direktan, kratke rečenice, bez okolišanja',
    'ton: topao i ohrabrujuć, kao stariji prijatelj',
    'ton: pragmatičan i konkretan, fokus na brojke i činjenice',
    'ton: znatiželjan i opservativan, kao da naglas čitaš njegov profil',
  ];
  const styles = [
    'stil: počni opažanjem o njemu, ne imenom posla',
    'stil: počni pitanjem ili malom provokacijom',
    'stil: počni konkretnom slikom iz njegove svakodnevice',
    'stil: počni onim što većina ljudi s njegovim tipom krivo radi',
    'stil: počni njegovom najjačom stranom pa je poveži s poslom',
  ];
  const angle = angles[flavor % angles.length];
  const tone = tones[Math.floor(flavor / 7) % tones.length];
  const styleHint = styles[Math.floor(flavor / 35) % styles.length];

  // I brojke se randomizuju server-side: bez ovoga model za isti input
  // konvergira ka istom score-u i istom rasponu zarade (testirano - 2x 94% i
  // 2x isti raspon), a prijatelji prvo porede brojke.
  const topScore = 86 + (flavor % 12);                                // 86-97
  const earnLow = 280 + (Math.floor(flavor / 12) % 8) * 25;           // 280-455
  const earnHigh = 1400 + (Math.floor(flavor / 96) % 10) * 140;       // 1400-2660

  const systemPrompt = `Ti si AI analitičar osobnosti za "Edit Unovac" (Tibor) - brend koji uči mlade ljude video editing kao online posao. Korisnik je upravo riješio kviz osobnosti (skraćeni MBTI + pitanja o preferencama). Tvoj zadatak: na temelju njegovih odgovora generiraj personaliziranu analizu i rangiranu listu online poslova koji mu pašu.

JEZIK: hrvatski (ijekavica), obraćanje na "ti". NIKAD ne koristi em crticu (—), koristi običnu crticu (-).

MBTI OSI (standardno značenje - koristi ih u analizi):
- E/I (Extraversion/Introversion): odakle vuče energiju - iz ljudi i akcije (E) ili iz mira i vlastitih misli (I).
- S/N (Sensing/iNtuition): kako prima informacije - konkretno, korak po korak, činjenice i praksa (S) ili velika slika, obrasci, mogućnosti i budućnost (N).
- T/F (Thinking/Feeling): kako odlučuje - logikom i objektivnim kriterijima (T) ili vrijednostima i utjecajem na ljude (F).
- J/P (Judging/Perceiving): kako organizira život - voli plan, strukturu, rokove i zatvaranje stvari (J) ili fleksibilnost, otvorene opcije i svoj tempo (P).
Sva 4 slova zajedno čine tip (npr. INTJ) - analiza mora odražavati KOMBINACIJU slova, ne samo E/I.

LOGIKA RANGIRANJA (pošteno usmjeravanje, NE rigganje):
- Poslovi koje rangiraš (točno 5): Video Editing, Appointment Setting, Copywriting, Social Media Management, Web Design.
- Video editing se za većinu tipova osobnosti pošteno uokviri pozitivno:
  - Introvert: radiš od doma, ni s kim ne moraš pričati, fokus i mir.
  - Ekstrovert: izražavaš se kroz video, prirodan stepping stone prema videografiji gdje snimaš poduzetnike i ulaziš u jak krug ljudi.
- Druge poslove prikaži pošteno, s pravim manama (npr. appointment setting: repetitivno, ovisiš o tuđem offeru, AI ga lako mijenja).
- Editingove mane preokreni u prednosti, ali iskreno: zarada ovisi o tebi, visok strop, zabavno (kao igra), AI te ne mijenja nego te čini bržim i vrjednijim.
- EDGE CASE: ako odgovori STVARNO ne pašu editingu (npr. izričito voli pričati i dogovarati s ljudima + ne smeta mu ovisiti o tuđem proizvodu + želi brze pare + nema interesa za kreativni rad), NE forsiraj editing na prvo mjesto. Stavi pošteno najbolji posao za njega na vrh, a editing rangiraj realno. To čuva kredibilitet.

PERSONALIZACIJA (NAJVAŽNIJE PRAVILO): rezultat mora djelovati pisan baš za ovu osobu, od nule. Korisnici su prijatelji koji su se međusobno pozvali i USPOREDIT će rezultate jedan pored drugog - čak i dvoje ljudi s IDENTIČNIM odgovorima mora dobiti tekstove koji izgledaju kao da su ih pisale dvije različite osobe. Konkretno:
- NIKAD ne koristi gotove fraze koje bi se mogle ponoviti ("tvoj fokus je tvoja supermoć", "editing je savršen za tebe" i slično) - svaku misao izrazi svježe.
- Variraj početke rečenica, dužinu rečenica, ritam, redoslijed argumenata, primjere i usporedbe.
- Variraj brojke: score postotke (ne okrugle), raspone zarade (realne, ali svaki put drugačije, npr. 340-780 EUR, 420-950 EUR...), redoslijed i sadržaj pluseva/minusa.
- Variraj nadimak tipa - za isti MBTI tip postoji više dobrih nadimaka, ne koristi uvijek isti.
- Ako spominješ njegovo ime, koristi ga prirodno (1-2 puta max, ne u svakoj rečenici).
Smjernice baš za OVU analizu (drže se dosljedno kroz cijeli output): ${angle}; ${tone}; ${styleHint}.

BROJKE: score je broj 0-100 (koliko mu posao paše). Scoreovi moraju biti različiti između poslova i NE okrugli (npr. 91, 78, 64... a ne 90, 80, 70). Zarade piši kao raspone u EUR. Za OVU analizu konkretno: score posla broj 1 neka bude točno ${topScore}, raspon zarade posla broj 1 neka krene oko ${earnLow} EUR i ide do oko ${earnHigh} EUR mjesečno (smiješ malo prilagoditi po satima koje ima na raspolaganju, ali se drži tih okvira). Ostale scoreove i raspone izvedi sam, razmaknute i nasumične.

OUTPUT: vrati ISKLJUČIVO validan JSON, bez markdown ograda, bez teksta prije ili poslije:
{
  "type": "XXXX",
  "nickname": "kratak nadimak tipa na hrvatskom (npr. Arhitekt, Vizionar, Graditelj...)",
  "readout": "3-4 rečenice o tome tko je on, kako funkcionira, što ga pokreće - osobno, kao da ga poznaješ",
  "jobs": [
    {
      "name": "ime posla",
      "score": 91,
      "why": "2-3 rečenice zašto mu (ne) paše, vezano za NJEGOVE odgovore",
      "earnings": "raspon zarade, npr. 500 - 2500 EUR mjesečno",
      "pros": ["plus 1", "plus 2", "plus 3"],
      "cons": ["minus 1", "minus 2"]
    }
  ],
  "transition": "1-2 rečenice koje ga vode u kalkulator zarade za posao broj 1, npr: Ok [ime], sad kad znaš da ti [posao] najbolje paše, da vidimo koliko konkretno možeš zaraditi."
}
"jobs" mora imati točno 5 poslova, sortirano po score silazno.`;

  const userPrompt = `Osoba: ${name || 'bez imena'}
MBTI tip (izračunat iz kviza): ${mbti}
Tjedno vremena na raspolaganju: ${hours || 'nepoznato'}
Seed varijacije: ${flavor}

Odgovori iz kviza:
${answersText}

Generiraj analizu i rangiranu listu poslova. Zapamti: isključivo JSON.`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        temperature: 1,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => '');
      console.error('[analyze] anthropic error', aiRes.status, errText.slice(0, 500));
      return res.status(502).json({ error: 'ai_unavailable' });
    }

    const data = await aiRes.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const result = parseJson(text);
    if (!result || !Array.isArray(result.jobs) || result.jobs.length === 0) {
      console.error('[analyze] bad ai output', text.slice(0, 500));
      return res.status(502).json({ error: 'ai_bad_output' });
    }

    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('[analyze] failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}

function cleanString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// AI ponekad omota JSON u ```json ograde ili doda rečenicu - izvuci prvi {...} blok.
function parseJson(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  if (!t.startsWith('{')) {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    t = t.slice(start, end + 1);
  }
  try { return JSON.parse(t); } catch { return null; }
}
