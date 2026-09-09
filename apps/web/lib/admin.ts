import { createHash, timingSafeEqual } from 'node:crypto';

export const adminCookie = 'everlenz_admin';

export function adminToken() {
  const password = process.env.IIOT_ADMIN_PASSWORD ?? '';
  return password
    ? createHash('sha256').update(`everlenz-admin-session:${password}`).digest('hex')
    : '';
}

export function validAdminToken(candidate: string | undefined) {
  const expected = adminToken();
  if (!candidate || !expected || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}
