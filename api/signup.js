// Vercel serverless function: POST /api/signup
// Poziva se sa thank-you stranice (GHL funnel) preko browser fetch-a.
// Upsert prijave u Supabase, vraća lični ref kod + share/dashboard linkove.
// Supabase-only mod — bez email alata (Tibor koristi GHL/AEvent za mejlove).
//
// ENV VARS REQUIRED:
//   SUPABASE_URL         (npr. https://qdllfhjlibyvwntwknkg.supabase.co)
//   SUPABASE_SECRET_KEY  (sb_secret_... — server-only, NIKAD u frontend)
//   WEBINAR_LANDING_URL  (fallback landing URL za share link)
//   DASHBOARD_BASE_URL   (npr. https://tibor-referral-system.vercel.app)
//
// ENV VARS OPCIONO — GHL email sa linkom (ako nisu postavljene, preskače se):
//   GHL_API_TOKEN        (Private Integration token, pit-...)
//   GHL_LOCATION_ID      (GHL Settings → Business Profile → Location ID)
//   GHL_FIELD_SHARE      (unique key custom polja za share URL, npr. contact.referral_share_url)
//   GHL_FIELD_DASHBOARD  (unique key custom polja za dashboard URL)
//   GHL_TAG              (tag koji okida workflow; default: referral-link-ready)

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
    signup = await createSignup({ email, firstName, lastName, ref });
  } catch (err) {
    console.error('supabase create_signup failed', err);
    return res.status(500).json({ error: 'supabase_error' });
  }

  const dashboardUrl = `${process.env.DASHBOARD_BASE_URL}/?t=${signup.dashboard_token}`;
  const shareUrl = `${webinarUrl}${webinarUrl.includes('?') ? '&' : '?'}r=${signup.ref_code}`;

  // GHL sync: upiši linkove u kontakt + tag koji okida email workflow.
  // Samo za nove prijave (da se email ne šalje ponovo), best-effort.
  if (signup.is_new) {
    try {
      await syncGhl({ email, firstName, lastName, refCode: signup.ref_code, shareUrl, dashboardUrl });
    } catch (err) {
      console.error('ghl sync failed', err);
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

async function createSignup({ email, firstName, lastName, ref }) {
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
async function syncGhl({ email, firstName, lastName, refCode, shareUrl, dashboardUrl }) {
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

  // 1. Upsert kontakta po emailu (AEvent ga je verovatno već kreirao — spaja se)
  const upsertRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      locationId,
      email,
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

  // 2. Dodaj tag (okida workflow). Poseban poziv da ne bismo prepisali postojeće tagove.
  const tag = process.env.GHL_TAG || 'referral-link-ready';
  const tagRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tags: [tag] }),
  });
  if (!tagRes.ok) {
    throw new Error(`ghl tag ${tagRes.status}: ${await tagRes.text()}`);
  }
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
