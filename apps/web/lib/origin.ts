import type { NextRequest } from 'next/server';

/**
 * Same-origin check for state-changing requests.
 *
 * The primary CSRF defence is the SameSite=Strict session cookie, which browsers refuse
 * to attach to cross-site requests at all. This is the second layer, so a future cookie
 * change cannot silently remove every protection at once.
 *
 * A missing Origin header is accepted on purpose: non-browser callers (the e2e script,
 * the load test, curl) do not send one, and they carry a bearer token rather than an
 * ambient cookie. SECURITY.md item 9 tracks moving to an explicit CSRF token, which
 * would let this fall back to deny.
 */
export function originAllowed(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const candidates = [
    request.headers.get('x-forwarded-host'),
    request.headers.get('host'),
    process.env.IIOT_WEB_DOMAIN,
    process.env.SERVICE_FQDN_WEB,
    process.env.SERVICE_URL_WEB,
  ];
  return candidates.some((candidate) =>
    candidate
      ?.split(',')
      .map((value) => externalHost(value))
      .includes(originHost),
  );
}

function externalHost(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  try {
    return new URL(normalized.includes('://') ? normalized : `https://${normalized}`).host;
  } catch {
    return '';
  }
}
