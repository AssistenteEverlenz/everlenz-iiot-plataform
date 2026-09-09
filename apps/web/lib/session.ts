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
