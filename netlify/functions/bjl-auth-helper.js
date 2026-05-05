/**
 * bjl-auth-helper.js — shared auth/whitelist helper for Netlify functions
 *
 * Single export: verifyAndAuthorize(authHeader)
 *
 * Returns one of:
 *   { ok: true,  user: { id, email, role, rate_limit_per_hour }, bypass?: true }
 *   { ok: false, status, error, message, email? }
 *
 * Behavior is gated by the AUTH_ENFORCED env var:
 *   - AUTH_ENFORCED === 'true'  → full check (token, JWT verify, whitelist, last_login_at update)
 *   - any other value           → bypass mode, returns { ok: true, user: null, bypass: true }
 *
 * The bypass mode lets the auth scaffolding deploy + soak in production
 * before the Microsoft Azure provider in Supabase Auth is fully wired up.
 * Flipping AUTH_ENFORCED=true in Netlify env vars activates the gate without
 * a code deploy.
 *
 * JWT verification is delegated to Supabase Auth's getUser() endpoint via
 * an anon-key client. The anon key is fine here because we're not using it
 * to read any tables — just to call /auth/v1/user with the user's bearer
 * token, which Supabase Auth verifies against its signing key.
 *
 * Whitelist lookup uses the service-role client so RLS doesn't gate it.
 * last_login_at is updated fire-and-forget — a slow auth dashboard write
 * shouldn't add latency to the user's query path.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AUTH_ENFORCED = process.env.AUTH_ENFORCED === 'true';

// Service-role client for whitelist reads + last_login_at writes. Created
// once at module load; the Netlify Function runtime keeps the module alive
// across warm invocations so this isn't re-initialized per request.
let _adminClient = null;
function adminClient() {
  if (_adminClient) return _adminClient;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('bjl-auth-helper: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  }
  _adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  return _adminClient;
}

async function verifyAndAuthorize(authHeader) {
  // Bypass mode — deploy can ship before the Azure provider goes live
  if (!AUTH_ENFORCED) {
    return { ok: true, user: null, bypass: true };
  }

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      error: 'missing_token',
      message: 'Authorization header required'
    };
  }
  const jwt = authHeader.slice('Bearer '.length).trim();
  if (!jwt) {
    return { ok: false, status: 401, error: 'missing_token', message: 'Authorization header empty' };
  }

  // Verify JWT via Supabase Auth's user endpoint. Anon-key client is
  // sufficient — getUser(jwt) calls /auth/v1/user with the token, which
  // Supabase Auth verifies internally using its signing key.
  if (!SUPABASE_ANON_KEY) {
    return { ok: false, status: 500, error: 'server_misconfigured', message: 'SUPABASE_ANON_KEY not set' };
  }
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  });

  let user;
  try {
    const { data, error } = await anonClient.auth.getUser(jwt);
    if (error || !data || !data.user) {
      return { ok: false, status: 401, error: 'invalid_token', message: (error && error.message) || 'Token invalid or expired' };
    }
    user = data.user;
  } catch (e) {
    return { ok: false, status: 401, error: 'invalid_token', message: e.message || 'Token verification failed' };
  }

  if (!user.email) {
    return { ok: false, status: 401, error: 'no_email_claim', message: 'Token did not include an email claim' };
  }

  // Whitelist check
  let row, dbErr;
  try {
    const result = await adminClient()
      .from('bjl_authorized_users')
      .select('email, role, rate_limit_per_hour, is_active')
      .eq('email', user.email)
      .maybeSingle();
    row = result.data;
    dbErr = result.error;
  } catch (e) {
    return { ok: false, status: 500, error: 'whitelist_lookup_failed', message: e.message };
  }
  if (dbErr) {
    return { ok: false, status: 500, error: 'whitelist_lookup_failed', message: dbErr.message };
  }
  if (!row) {
    return {
      ok: false,
      status: 403,
      error: 'not_whitelisted',
      email: user.email,
      message: `Email ${user.email} is not authorized for the BJL Intelligence Engine. Contact Eli at haddowe@peteramayer.com to request access.`
    };
  }
  if (!row.is_active) {
    return {
      ok: false,
      status: 403,
      error: 'access_revoked',
      email: user.email,
      message: `Access for ${user.email} has been revoked. Contact Eli at haddowe@peteramayer.com.`
    };
  }

  // Fire-and-forget last_login_at update — don't block the user's query on
  // this. Errors are logged but never returned to the client.
  adminClient()
    .from('bjl_authorized_users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('email', user.email)
    .then(
      () => {},
      (e) => console.warn('[bjl-auth-helper] last_login_at update failed:', e && e.message)
    );

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      role: row.role,
      rate_limit_per_hour: row.rate_limit_per_hour
    }
  };
}

module.exports = { verifyAndAuthorize, AUTH_ENFORCED };
