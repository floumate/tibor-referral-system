// Vercel serverless function: POST /api/signup
// Poziva se sa thank-you stranice (GHL funnel) preko browser fetch-a.
// Upsert prijave u Supabase, vraća lični ref kod + share/dashboard linkove.
// Supabase-only mod — bez email alata (Tibor koristi GHL/AEvent za mejlove).
//
// ENV VARS REQUIRED:
//   SUPABASE_URL         (npr. https://qdllfhjlibyvwntwknkg.supabase.co)
//   SUPABASE_SECRET_KEY  (sb_secret_... — server-only, NIKAD u frontend)
//   WEBINAR_LANDING_URL  (fallback landing URL za share link)
//   DASHBOARD_BASE_URL   (npr. https://uzivo-trening.vercel.app)
//
// ENV VARS OPCIONO — GHL integracija (ako GHL_API_TOKEN/GHL_LOCATION_ID nisu postavljeni, preskače se):
//   GHL_API_TOKEN        (Private Integration token, pit-...)
//   GHL_LOCATION_ID      (GHL Settings → Business Profile → Location ID)
//   GHL_FIELD_SHARE      (unique key custom polja za share URL, npr. contact.referral_share_url)
//   GHL_FIELD_DASHBOARD  (unique key custom polja za dashboard URL)
//   GHL_TAG              (tag na svaku prijavu; default: referral-link-ready)
//   GHL_WINNER_TAG       (tag kad referrer dostigne prag — okida reward workflow)
//   REWARD_THRESHOLD     (prag referala za winner tag; default 5)

export const config = { runtime: 'nodejs' };

const ALLOWED_ORIGINS = [
  'https://uzivotrening.editunovac.com',
  'https://editunovac.com',
  'https://www.editunovac.com',
];

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const email = cleanString(body.email).toLowerCase();
  const ref = cleanString(body.ref);
  const phone = cleanString(body.phone);  // E.164 (npr. +38760123456) — upisuje se u GHL kontakt

  // IP prijave: čita se SERVER-SIDE iz zaglavlja koje postavlja Vercel/proxy —
  // korisnik ga ne šalje pa ne može da ga lažira. Koristi se za detekciju
  // prevare (rafal prijava sa istog IP-a). x-forwarded-for je lista "client, proxy1, ..."
  // pa uzimamo prvi (pravi klijent). Vidi ANTI-FRAUD.md za strategiju.
  const fwd = req.headers['x-forwarded-for'] || '';
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim()
    || cleanString(req.headers['x-real-ip']);
  const userAgent = cleanString(req.headers['user-agent']).slice(0, 400);

  // Ime stiže ili kao puno ime ("name") ili razdvojeno (first_name/last_name)
  let firstName = cleanString(body.firstName || body.first_name);
  let lastName = cleanString(body.lastName || body.last_name);
  if (!firstName) {
    const split = splitName(cleanString(body.name));
    firstName = split.firstName || '';
    lastName = lastName || split.lastName || '';
  }

  // Body URL ima prednost (omogućava da jedan API služi više landing stranica),
  // env je fallback.
  const webinarUrl = cleanString(body.webinarUrl) || cleanString(process.env.WEBINAR_LANDING_URL);

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (!webinarUrl) {
    return res.status(400).json({ error: 'missing_config' });
  }

  let signup;
  try {
    signup = await createSignup({ email, firstName, lastName, ref, ip, userAgent });
  } catch (err) {
    console.error('supabase create_signup failed', err);
    return res.status(500).json({ error: 'supabase_error' });
  }

  const dashboardUrl = `${process.env.DASHBOARD_BASE_URL}/?t=${signup.dashboard_token}`;
  // Čist referral link (r= prvi, bez uglastih zagrada koje lome URL) — ide u GHL custom field
  // refferal_link, pa ga GHL email/WhatsApp može slati korisniku ({{contact.refferal_link}}).
  const shareUrl = `https://uzivotrening.editunovac.com/optin?r=${signup.ref_code}&el=referral_evergreen_webinar_url_thankyou&hgoal=evergreen_webinar&htrafficsource=referral&source=referral`;

  // GHL kontakt sync (telefon + opciono custom polja/tag) — UVIJEK, idempotentno.
  // NE samo na prvu prijavu: da telefon legne i kod ponovne prijave ili ako je kontakt
  // ranije obrisan. syncGhl interno preskoči ako nema šta da se upiše (npr. thank-you poziv bez telefona).
  try {
    await syncGhl({ email, phone, firstName, lastName, refCode: signup.ref_code, shareUrl, dashboardUrl });
  } catch (err) {
    console.error('ghl sync failed', err);
  }

  // Winner tag: ako ova nova prijava preko nečijeg linka digne tog referrera na prag
  // (default 5), dodaj mu GHL tag koji okida reward workflow. Tačno jednom (reward_sent).
  if (signup.is_new && signup.referred_by) {
    try {
      await maybeTagWinner(signup.referred_by);
    } catch (err) {
      console.error('maybeTagWinner failed', err);
    }
  }

  return res.status(200).json({
    ok: true,
    refCode: signup.ref_code,
    dashboardUrl,
    shareUrl,
    isNew: signup.is_new,
    firstName: firstName || null,
  });
}

// ----- helpers -----

async function createSignup({ email, firstName, lastName, ref, ip, userAgent }) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/create_signup`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
    body: JSON.stringify({
      p_email: email,
      p_first_name: firstName || null,
      p_last_name: lastName || null,
      p_referred_by: ref || null,
      p_ip: ip || null,
      p_user_agent: userAgent || null,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`supabase ${resp.status}: ${txt}`);
  }

  const rows = await resp.json();
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new Error('supabase returned no row');
  return {
    ref_code: row.out_ref_code,
    dashboard_token: row.out_dashboard_token,
    is_new: row.out_is_new,
    referred_by: row.out_referred_by,
  };
}

// GHL (LeadConnector) API v2: upsert kontakta sa custom poljima + tag.
// Tag okida GHL workflow koji šalje email sa referral linkovima.
async function syncGhl({ email, phone, firstName, lastName, refCode, shareUrl, dashboardUrl }) {
  const token = process.env.GHL_API_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) return; // GHL integracija nije podešena — preskoči

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };

  // Unique key polja iz GHL-a, prihvata i sa i bez "contact." prefiksa
  const fieldKey = (v) => (v || '').replace(/^contact\./, '');
  const customFields = [];
  if (process.env.GHL_FIELD_SHARE) {
    customFields.push({ key: fieldKey(process.env.GHL_FIELD_SHARE), field_value: shareUrl });
  }
  if (process.env.GHL_FIELD_DASHBOARD) {
    customFields.push({ key: fieldKey(process.env.GHL_FIELD_DASHBOARD), field_value: dashboardUrl });
  }
  if (process.env.GHL_FIELD_CODE) {
    customFields.push({ key: fieldKey(process.env.GHL_FIELD_CODE), field_value: refCode });
  }

  // Per-signup tag je OPT-IN (samo ako je GHL_TAG eksplicitno postavljen). Bez defaulta.
  const tag = cleanString(process.env.GHL_TAG);

  // Ako nema ničega za upis (ni telefon, ni custom polja, ni tag) — preskoči poziv.
  if (!phone && customFields.length === 0 && !tag) return;

  // 1. Upsert kontakta po emailu (AEvent ga je već kreirao — spaja se; dodajemo telefon).
  const upsertRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      locationId,
      email,
      phone: phone || undefined,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      customFields,
    }),
  });
  if (!upsertRes.ok) {
    throw new Error(`ghl upsert ${upsertRes.status}: ${await upsertRes.text()}`);
  }
  const contactId = (await upsertRes.json())?.contact?.id;
  if (!contactId) throw new Error('ghl upsert: no contact id');

  // 2. Dodaj tag SAMO ako je GHL_TAG postavljen. Poseban poziv (ne prepisuje postojeće tagove).
  if (tag) {
    const tagRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags: [tag] }),
    });
    if (!tagRes.ok) {
      throw new Error(`ghl tag ${tagRes.status}: ${await tagRes.text()}`);
    }
  }
}

// Kad referrer dostigne prag referala, dodaj mu GHL "winner" tag (okida reward workflow).
// Tačno jednom: štiti se Supabase kolonom reward_sent. Best-effort.
async function maybeTagWinner(referrerRefCode) {
  const token = process.env.GHL_API_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  const winnerTag = cleanString(process.env.GHL_WINNER_TAG);
  const threshold = Number(process.env.REWARD_THRESHOLD || 5);
  if (!token || !locationId || !winnerTag) return; // winner tag nije podešen — preskoči

  const supaHeaders = {
    apikey: process.env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
  };
  const enc = encodeURIComponent(referrerRefCode);

  // Referrer (email + ime + da li je nagrada već poslata) i broj njegovih referala.
  const [refRes, countRes] = await Promise.all([
    fetch(`${process.env.SUPABASE_URL}/rest/v1/signups?ref_code=eq.${enc}&select=email,first_name,last_name,reward_sent&limit=1`, { headers: supaHeaders }),
    fetch(`${process.env.SUPABASE_URL}/rest/v1/signups?referred_by=eq.${enc}&select=ref_code`, {
      headers: { ...supaHeaders, Prefer: 'count=exact' },
    }),
  ]);
  if (!refRes.ok || !countRes.ok) {
    throw new Error(`maybeTagWinner supabase ${refRes.status}/${countRes.status}`);
  }

  const rows = await refRes.json();
  const referrer = Array.isArray(rows) ? rows[0] : null;
  if (!referrer || !referrer.email) return;
  if (referrer.reward_sent === true) return; // već tagovan — ne okidaj workflow ponovo

  const range = countRes.headers.get('content-range') || '*/0';
  const total = parseInt(range.split('/')[1] || '0', 10);
  if (total < threshold) return; // još nije dostigao prag

  // 1. Upsert kontakta po emailu + 2. dodaj winner tag (okida reward workflow).
  const ghlHeaders = { Authorization: `Bearer ${token}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  const upsertRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: ghlHeaders,
    body: JSON.stringify({
      locationId,
      email: referrer.email,
      firstName: referrer.first_name || undefined,
      lastName: referrer.last_name || undefined,
    }),
  });
  if (!upsertRes.ok) throw new Error(`ghl winner upsert ${upsertRes.status}: ${await upsertRes.text()}`);
  const contactId = (await upsertRes.json())?.contact?.id;
  if (!contactId) throw new Error('ghl winner upsert: no contact id');

  const tagRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: ghlHeaders,
    body: JSON.stringify({ tags: [winnerTag] }),
  });
  if (!tagRes.ok) throw new Error(`ghl winner tag ${tagRes.status}: ${await tagRes.text()}`);

  // 3. Označi da je nagrada poslata (da workflow ne okine ponovo na sledeću prijavu).
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/signups?ref_code=eq.${enc}`, {
    method: 'PATCH',
    headers: { ...supaHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ reward_sent: true }),
  });

  console.log(`[winner] tagovan ${referrer.email} sa "${winnerTag}" (count=${total})`);
}

function cleanString(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}

function splitName(full) {
  if (!full) return { firstName: null, lastName: null };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
