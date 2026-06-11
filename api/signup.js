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
