import { NextRequest, NextResponse } from 'next/server';
import { apiUrl, sessionCookie, sessionCookieOptions } from '../../../../lib/session';
import { originAllowed } from '../../../../lib/origin';

export async function POST(request: NextRequest) {
  // Blocks login-CSRF: an attacker silently signing a victim into an account they own.
  if (!originAllowed(request))
    return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const result = await fetch(apiUrl('auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: await request.text(),
    cache: 'no-store',
  });
  const body = (await result.json()) as { token?: string; user?: unknown; error?: string };
  if (!result.ok || !body.token)
    return NextResponse.json(
      { error: body.error ?? 'Não foi possível entrar' },
      { status: result.status },
    );
  const response = NextResponse.json({ user: body.user });
  response.cookies.set(sessionCookie, body.token, sessionCookieOptions);
  return response;
}
