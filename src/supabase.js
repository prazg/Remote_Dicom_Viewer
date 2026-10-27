import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
export const IDLE_MINUTES = Number(import.meta.env.VITE_IDLE_MINUTES || 15);
export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

// Read before the client consumes the URL: invite and password-reset links
// arrive as #access_token=…&type=invite|recovery, or #error_description=… if expired.
const hashParams = new URLSearchParams(window.location.hash.slice(1));
export const urlAuth = {
  type: hashParams.get('type'),
  error: hashParams.get('error_description'),
};

// Sessions live in sessionStorage: closing the tab signs the user out, which
// suits shared clinical workstations. The publishable key is public by design;
// all protection is enforced by the database's row-level security.
export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        storage: window.sessionStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

/** Throws a readable error from a Supabase response. */
export function must({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

/** Calls an Edge Function with the signed-in user's session; throws with the function's message. */
export async function callFunction(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${session?.access_token ?? ''}` },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}
