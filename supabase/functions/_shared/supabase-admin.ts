// Server-side helpers shared by the Edge Functions. No third-party imports.

export const env = (k: string) => Deno.env.get(k) ?? '';

/** The project's secret key (bypasses RLS). Never sent to browsers. */
export function secretKey(): string {
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
    if (keys.default) return keys.default;
  } catch { /* fall back to legacy key */ }
  return env('SUPABASE_SERVICE_ROLE_KEY');
}

function adminHeaders(extra?: HeadersInit): Headers {
  const key = secretKey();
  const h = new Headers(extra);
  h.set('apikey', key);
  if (key.startsWith('eyJ')) h.set('Authorization', `Bearer ${key}`); // legacy JWT key
  if (!h.has('Content-Type')) h.set('Content-Type', 'application/json');
  return h;
}

/** Calls the project's REST (PostgREST) API as the service role. */
export function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, { ...init, headers: adminHeaders(init.headers) });
}

/** Calls the project's Auth admin API as the service role. */
export function authAdmin(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env('SUPABASE_URL')}/auth/v1/${path}`, { ...init, headers: adminHeaders(init.headers) });
}

export const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export const isUuid = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function audit(actor: { id: string; email: string } | null, action: string, detail: Record<string, unknown>) {
  await rest('audit_log', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, action, detail }),
  });
}
