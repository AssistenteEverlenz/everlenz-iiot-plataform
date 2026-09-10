import type { NextRequest } from 'next/server';

export const sessionCookie = 'everlenz_session';

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: 60 * 60 * 12,
};

export function apiUrl(path: string) {
  return `${process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001'}/api/${path}`;
}

/**
 * Carries the browser's address to the API.
 *
 * The API is only reachable through this server, so without this header it sees every
 * user as the web container (a 10.x Docker address). That silently merged all users into
 * one rate-limit bucket, which locked the whole platform, and recorded the container
 * instead of the real client in app_sessions and audit_log.
 *
 * The value is the header Traefik set on the way in. The API trusts exactly one hop (this
 * server) and takes the right-most entry, the one Traefik appended, so a client that
 * sends its own X-Forwarded-For still cannot forge the address the API ends up using.
 */
export function clientAddressHeaders(request: NextRequest): Record<string, string> {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded ? { 'x-forwarded-for': forwarded } : {};
}
