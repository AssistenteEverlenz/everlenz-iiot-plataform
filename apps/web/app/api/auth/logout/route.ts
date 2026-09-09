import { NextRequest, NextResponse } from 'next/server';
import { apiUrl, sessionCookie } from '../../../../lib/session';

export async function POST(request: NextRequest) {
  const token = request.cookies.get(sessionCookie)?.value;
  if (token)
    await fetch(apiUrl('auth/logout'), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    }).catch(() => undefined);
  const response = NextResponse.json({ authenticated: false });
  response.cookies.delete(sessionCookie);
  return response;
}
